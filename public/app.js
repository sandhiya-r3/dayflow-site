(function () {
  'use strict';

  var MOODS = [
    { v: 1, face: '😞', name: 'Rough', c: 'var(--m1)' },
    { v: 2, face: '😕', name: 'Low',   c: 'var(--m2)' },
    { v: 3, face: '😐', name: 'Okay',  c: 'var(--m3)' },
    { v: 4, face: '🙂', name: 'Good',  c: 'var(--m4)' },
    { v: 5, face: '😄', name: 'Great', c: 'var(--m5)' }
  ];
  var TAGS = ['Work', 'Family', 'Friends', 'Health', 'Sleep', 'Exercise', 'Study', 'Rest'];

  // ---------- small helpers ----------
  function moodFor(v) { return MOODS.filter(function (m) { return m.v === v; })[0]; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(k) { var p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function currentStreak(entries) {
    var cur = new Date();
    if (!entries[dateKey(cur)]) cur.setDate(cur.getDate() - 1);
    var n = 0;
    while (entries[dateKey(cur)]) { n++; cur.setDate(cur.getDate() - 1); }
    return n;
  }

  // ---------- API ----------
  function ApiError(message, status) {
    this.message = message;
    this.status = status;
  }

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new ApiError((data && data.error) || 'Something went wrong.', res.status);
          return data;
        });
      },
      function () { throw new ApiError('Cannot reach the server. Check that it is running.', 0); }
    );
  }

  // ---------- state ----------
  var state = {
    phase: 'loading',     // loading | auth | app | error
    user: null,
    entries: {},
    tab: 'today',
    feed: [],
    feedState: 'idle',     // idle | loading | error
    confirmRemove: null,
    draft: { mood: null, tags: [], note: '', shared: false },
    confirmDelete: null,
    authMode: 'login',
    authError: '',
    busy: false
  };

  var app = document.getElementById('app');
  var tabbar = document.getElementById('tabbar');

  function resetDraft() {
    var e = state.entries[dateKey()];
    state.draft = e
      ? { mood: e.mood, tags: e.tags.slice(), note: e.note, shared: e.shared === true }
      : { mood: null, tags: [], note: '', shared: Boolean(state.user && state.user.isAdmin) };
  }

  // ---------- views ----------
  function viewAuth() {
    var signup = state.authMode === 'signup';
    var h = '<div class="auth"><div class="eyebrow">DayFlow</div>' +
      '<h1>A few lines a day. See how your mood moves.</h1>' +
      '<p class="lede">Record how you felt, tag what shaped it, and spot patterns over time.</p>' +
      '<form id="auth-form" class="card form" novalidate>';
    if (signup) {
      h += '<div class="field"><label for="auth-name">Name</label>' +
        '<input id="auth-name" name="name" type="text" autocomplete="name" maxlength="60" required></div>';
    }
    h += '<div class="field"><label for="auth-email">Email</label>' +
      '<input id="auth-email" name="email" type="email" autocomplete="email" inputmode="email" required></div>' +
      '<div class="field"><label for="auth-password">Password</label>' +
      '<input id="auth-password" name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" minlength="8" required>' +
      (signup ? '<small>At least 8 characters.</small>' : '') + '</div>' +
      (signup ? '<p class="privacy">Your entries are private unless you choose to share one. Shared entries show your first name.</p>' : '') +
      '<p class="error" id="auth-error" role="alert">' + esc(state.authError) + '</p>' +
      '<button class="save" type="submit" id="auth-submit">' + (signup ? 'Create account' : 'Log in') + '</button></form>' +
      '<p class="switch">' + (signup
        ? 'Already have an account? <button type="button" class="text-btn" data-act="mode-login">Log in</button>'
        : 'New here? <button type="button" class="text-btn" data-act="mode-signup">Create an account</button>') +
      '</p><p class="switch"><a class="text-btn" href="/read.html">Just reading? Open the public journal</a></p></div>';
    return h;
  }

  function topbar() {
    return '<header class="topbar"><span class="brand">DayFlow</span><div class="who"><span>' +
      esc(state.user.name) + '</span><button type="button" class="link-btn" data-act="logout">Log out</button></div></header>';
  }

  function viewToday() {
    var d = state.draft;
    var existing = state.entries[dateKey()];
    var date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    var streak = currentStreak(state.entries);
    var h = '<div class="eyebrow">' + esc(date) + '</div><h1>How was your day?</h1>';
    if (streak > 0) h += '<div class="streak">' + streak + '-day streak</div>';
    h += '<div class="moods" role="group" aria-label="Mood">';
    MOODS.forEach(function (m) {
      h += '<button type="button" class="mood" data-mood="' + m.v + '" style="--mc:' + m.c + '" aria-pressed="' + (d.mood === m.v) + '">' +
        '<span class="face" aria-hidden="true">' + m.face + '</span><span class="name">' + m.name + '</span></button>';
    });
    h += '</div><div class="label">What shaped it?</div><div class="tags" role="group" aria-label="Tags">';
    TAGS.forEach(function (t) {
      h += '<button type="button" class="tag" data-tag="' + t + '" aria-pressed="' + (d.tags.indexOf(t) > -1) + '">' + t + '</button>';
    });
    h += '</div><label class="label" for="note">Write a few lines</label>' +
      '<textarea id="note" maxlength="5000" placeholder="Anything worth remembering about today…">' + esc(d.note) + '</textarea>' +
      '<label class="share" for="share"><input type="checkbox" id="share"' + (d.shared ? ' checked' : '') + '>' +
      '<span>' + (state.user && state.user.isAdmin
        ? 'Post publicly. Anyone with the link can read this entry on the public page (/read.html), with no login. Untick to keep it private.'
        : 'Share this entry on the community feed. Other people will see your first name, mood, tags and note. Off by default.') +
      '</span></label>' +
      '<button type="button" class="save" id="save-btn" data-act="save"' + (d.mood ? '' : ' disabled') + '>' +
      (existing ? 'Update entry' : 'Save entry') + '</button>';
    if (!d.mood) h += '<p class="hint">Pick a mood to save today\'s entry.</p>';
    return h;
  }

  function viewJournal() {
    var keys = Object.keys(state.entries).sort().reverse();
    var h = '<h1>Your journal</h1><div style="height:16px"></div>';
    if (!keys.length) {
      return h + '<div class="empty"><strong>No entries yet</strong>Entries you save on Today show up here.</div>';
    }
    keys.forEach(function (k) {
      var e = state.entries[k], m = moodFor(e.mood);
      var label = parseKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      h += '<article class="entry" style="--mc:' + m.c + '"><div class="entry-head"><span class="entry-date">' + esc(label) + '</span>' +
        '<span class="entry-mood">' + m.face + ' ' + m.name + '</span></div>';
      if (e.shared && !e.hidden) h += '<p class="entry-shared">Shared on the community feed</p>';
      if (e.tags && e.tags.length) h += '<p class="entry-tags">' + esc(e.tags.join(' · ')) + '</p>';
      if (e.note) h += '<p class="entry-note">' + esc(e.note) + '</p>';
      h += '<div class="entry-actions">';
      if (state.confirmDelete === k) {
        h += '<span>Delete this entry?</span><button type="button" class="link-btn danger" data-act="delete-yes" data-key="' + k + '">Delete</button>' +
          '<button type="button" class="link-btn" data-act="delete-no">Cancel</button>';
      } else {
        h += '<button type="button" class="link-btn" data-act="delete" data-key="' + k + '">Delete</button>';
      }
      h += '</div></article>';
    });
    return h;
  }

  function viewInsights() {
    var all = Object.keys(state.entries).map(function (k) { return state.entries[k]; });
    var h = '<h1>Insights</h1>';
    if (!all.length) return h + '<div class="empty"><strong>Nothing to show yet</strong>Add your first entry to see insights.</div>';

    var avg = all.reduce(function (s, e) { return s + e.mood; }, 0) / all.length;
    var avgMood = moodFor(Math.round(avg));
    h += '<div class="stats"><div class="stat"><b>' + all.length + '</b><span>Entries</span></div>' +
      '<div class="stat"><b>' + currentStreak(state.entries) + '</b><span>Day streak</span></div>' +
      '<div class="stat"><b>' + avgMood.face + ' ' + avg.toFixed(1) + '</b><span>Avg mood</span></div></div>';

    h += '<div class="label">Last 7 days</div><div class="card"><div class="week">';
    for (var i = 6; i >= 0; i--) {
      var d = daysAgo(i), e = state.entries[dateKey(d)], m = e ? moodFor(e.mood) : null;
      var ht = m ? Math.round(e.mood / 5 * 96) : 4;
      h += '<div class="day"><div class="track"><div class="bar" style="height:' + ht + 'px;' + (m ? '--mc:' + m.c : '') + '"></div></div>' +
        '<div class="face" aria-hidden="true">' + (m ? m.face : '') + '</div>' +
        '<div class="dl">' + d.toLocaleDateString(undefined, { weekday: 'narrow' }) + '</div></div>';
    }
    h += '</div></div>';

    var counts = MOODS.map(function (m) { return { m: m, n: all.filter(function (e) { return e.mood === m.v; }).length }; });
    var max = Math.max.apply(null, counts.map(function (c) { return c.n; }).concat(1));
    h += '<div class="label">Mood breakdown</div><div class="card">';
    counts.forEach(function (c) {
      h += '<div class="dist"><span class="n">' + c.m.face + ' ' + c.m.name + '</span><div class="t"><div class="f" style="--mc:' + c.m.c + ';width:' + (c.n / max * 100) + '%"></div></div><span class="c">' + c.n + '</span></div>';
    });
    h += '</div>';

    var tc = {};
    all.forEach(function (e) { (e.tags || []).forEach(function (t) { tc[t] = (tc[t] || 0) + 1; }); });
    var top = Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a]; }).slice(0, 4);
    if (top.length) {
      h += '<div class="label">Most mentioned</div><div class="card">';
      top.forEach(function (t) { h += '<div class="toprow"><span>' + t + '</span><span>' + tc[t] + (tc[t] === 1 ? ' day' : ' days') + '</span></div>'; });
      h += '</div>';
    }
    return h;
  }

  function viewCommunity() {
    var h = '<h1>Community</h1><p class="lede">Entries that people chose to share. Private entries never appear here.</p>';
    if (state.feedState === 'loading') return h + '<p class="loading">Loading…</p>';
    if (state.feedState === 'error') {
      return h + '<div class="empty"><strong>Could not load the feed</strong>Check your connection and try again.' +
        '<p><button type="button" class="save" data-act="reload-feed">Try again</button></p></div>';
    }
    if (!state.feed.length) {
      return h + '<div class="empty"><strong>Nothing shared yet</strong>Turn on "Share this entry" on the Today tab to post one.</div>';
    }
    state.feed.forEach(function (it) {
      var m = moodFor(it.mood);
      var label = parseKey(it.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      h += '<article class="entry" style="--mc:' + m.c + '"><div class="entry-head"><span class="entry-date">' +
        esc(it.author) + (it.mine ? ' (you)' : '') + '</span><span class="entry-mood">' + m.face + ' ' + m.name + '</span></div>' +
        '<p class="entry-when">' + esc(label) + '</p>';
      if (it.tags && it.tags.length) h += '<p class="entry-tags">' + esc(it.tags.join(' · ')) + '</p>';
      if (it.note) h += '<p class="entry-note">' + esc(it.note) + '</p>';
      if (it.id) {
        h += '<div class="entry-actions">';
        if (state.confirmRemove === it.id) {
          h += '<span>Remove from the feed for good?</span><button type="button" class="link-btn danger" data-act="remove-yes" data-id="' + esc(it.id) + '">Remove</button>' +
            '<button type="button" class="link-btn" data-act="remove-no">Cancel</button>';
        } else {
          h += '<button type="button" class="link-btn danger" data-act="remove" data-id="' + esc(it.id) + '">Remove post</button>';
        }
        h += '</div>';
      }
      h += '</article>';
    });
    return h;
  }

  function render() {
    tabbar.hidden = state.phase !== 'app';
    if (state.phase === 'loading') {
      app.innerHTML = '<p class="loading">Loading…</p>';
    } else if (state.phase === 'error') {
      app.innerHTML = '<div class="empty"><strong>Can\'t reach DayFlow</strong>' + esc(state.authError) +
        '<p><button type="button" class="save" data-act="retry">Try again</button></p></div>';
    } else if (state.phase === 'auth') {
      app.innerHTML = viewAuth();
    } else {
      var body = state.tab === 'today' ? viewToday()
        : state.tab === 'journal' ? viewJournal()
        : state.tab === 'community' ? viewCommunity()
        : viewInsights();
      app.innerHTML = topbar() + body;
      ['today', 'journal', 'community', 'insights'].forEach(function (t) {
        document.getElementById('tab-' + t).setAttribute('aria-selected', String(state.tab === t));
      });
    }
  }

  var toastTimer;
  function toast(msg) {
    var slot = document.getElementById('toast-slot');
    slot.innerHTML = '<div class="toast">' + esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { slot.innerHTML = ''; }, 2200);
  }

  // ---------- flow ----------
  function enterApp(user) {
    state.user = user;
    return api('GET', '/api/entries').then(function (data) {
      state.entries = data.entries || {};
      state.phase = 'app';
      state.tab = 'today';
      state.confirmDelete = null;
      resetDraft();
      render();
    });
  }

  function goToAuth(message) {
    state.user = null;
    state.entries = {};
    state.phase = 'auth';
    state.authMode = 'login';
    state.authError = message || '';
    render();
  }

  function boot() {
    state.phase = 'loading';
    render();
    api('GET', '/api/me')
      .then(function (data) { return enterApp(data.user); })
      .catch(function (err) {
        if (err.status === 401) { goToAuth(''); return; }
        state.phase = 'error';
        state.authError = err.message;
        render();
      });
  }

  function loadFeed() {
    state.feedState = 'loading';
    render();
    api('GET', '/api/feed')
      .then(function (data) { state.feed = data.items || []; state.feedState = 'idle'; render(); })
      .catch(function (err) {
        if (err.status === 401) { goToAuth('Your session ended. Please log in again.'); return; }
        state.feedState = 'error';
        render();
      });
  }

  function handleFailure(err) {
    if (err.status === 401) { goToAuth('Your session ended. Please log in again.'); return; }
    toast(err.message);
  }

  // ---------- events ----------
  tabbar.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.getAttribute('data-tab');
    state.confirmDelete = null;
    state.confirmRemove = null;
    if (state.tab === 'today') resetDraft();
    if (state.tab === 'community') { loadFeed(); } else { render(); }
    window.scrollTo(0, 0);
  });

  app.addEventListener('input', function (ev) {
    if (ev.target.id === 'note') state.draft.note = ev.target.value;
    if (ev.target.id === 'share') state.draft.shared = ev.target.checked;
  });

  app.addEventListener('submit', function (ev) {
    if (ev.target.id !== 'auth-form') return;
    ev.preventDefault();
    if (state.busy) return;
    var signup = state.authMode === 'signup';
    var form = ev.target;
    var payload = {
      email: form.elements.email.value.trim(),
      password: form.elements.password.value
    };
    if (signup) payload.name = form.elements.name.value.trim();

    var errBox = document.getElementById('auth-error');
    if (signup && !payload.name) { errBox.textContent = 'Enter your name.'; return; }
    if (!payload.email) { errBox.textContent = 'Enter your email address.'; return; }
    if (payload.password.length < 8) { errBox.textContent = 'Password must be at least 8 characters.'; return; }

    state.busy = true;
    errBox.textContent = '';
    var btn = document.getElementById('auth-submit');
    btn.disabled = true;
    api('POST', signup ? '/api/signup' : '/api/login', payload)
      .then(function (data) { return enterApp(data.user); })
      .catch(function (err) {
        errBox.textContent = err.message;
        btn.disabled = false;
      })
      .then(function () { state.busy = false; });
  });

  app.addEventListener('click', function (ev) {
    var t = ev.target.closest('button');
    if (!t) return;
    var act = t.getAttribute('data-act');

    if (t.hasAttribute('data-mood')) {
      state.draft.mood = Number(t.getAttribute('data-mood'));
      render();
    } else if (t.hasAttribute('data-tag')) {
      var tag = t.getAttribute('data-tag'), i = state.draft.tags.indexOf(tag);
      if (i > -1) state.draft.tags.splice(i, 1); else state.draft.tags.push(tag);
      render();
    } else if (act === 'save') {
      if (!state.draft.mood || state.busy) return;
      var key = dateKey();
      state.busy = true;
      t.disabled = true;
      api('PUT', '/api/entries/' + key, { mood: state.draft.mood, tags: state.draft.tags, note: state.draft.note, shared: state.draft.shared })
        .then(function (data) {
          var wantedShare = state.draft.shared;
          state.entries[key] = data.entry;
          state.draft.shared = data.entry.shared === true;
          render();
          toast(wantedShare && data.entry.hidden
            ? 'Saved. The site owner removed this entry from the feed, so it stays private.'
            : 'Saved');
        })
        .catch(function (err) { t.disabled = false; handleFailure(err); })
        .then(function () { state.busy = false; });
    } else if (act === 'delete') {
      state.confirmDelete = t.getAttribute('data-key');
      render();
    } else if (act === 'delete-no') {
      state.confirmDelete = null;
      render();
    } else if (act === 'delete-yes') {
      var dk = t.getAttribute('data-key');
      api('DELETE', '/api/entries/' + dk)
        .then(function () {
          delete state.entries[dk];
          state.confirmDelete = null;
          render();
          toast('Entry deleted');
        })
        .catch(handleFailure);
    } else if (act === 'reload-feed') {
      loadFeed();
    } else if (act === 'remove') {
      state.confirmRemove = t.getAttribute('data-id');
      render();
    } else if (act === 'remove-no') {
      state.confirmRemove = null;
      render();
    } else if (act === 'remove-yes') {
      var rid = t.getAttribute('data-id');
      api('DELETE', '/api/feed/' + rid)
        .then(function () {
          state.feed = state.feed.filter(function (x) { return x.id !== rid; });
          state.confirmRemove = null;
          render();
          toast('Post removed from the feed');
        })
        .catch(handleFailure);
    } else if (act === 'logout') {
      api('POST', '/api/logout').catch(function () {}).then(function () { goToAuth(''); });
    } else if (act === 'mode-signup' || act === 'mode-login') {
      state.authMode = act === 'mode-signup' ? 'signup' : 'login';
      state.authError = '';
      render();
    } else if (act === 'retry') {
      boot();
    }
  });

  boot();
})();
