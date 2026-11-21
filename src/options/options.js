/*
 * Options page. Toggles save immediately; the playerType list and the allowlist save after
 * validation. Twitch/master settings live under "settings" (src/shared/settings.js), the
 * all-sites settings and allowlist under "blocking" (src/shared/blocking.js), "My filters" under
 * "userFilters" (src/shared/userfilters.js; the element picker adds to it). "Support Ad Shield"
 * shows the tip link and the USDC and BTC addresses from src/shared/donate.js.
 */
(function () {
  'use strict';
  var ns = globalThis.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
  var U = ns.userFilters;
  var cfg = ns.config;
  var $ = function (id) { return document.getElementById(id); };
  var settings = S.defaults();
  var blocking = B.defaults();

  function save(next) {
    var v = S.validate(next);
    if (!v.ok) return Promise.reject(v.errors);
    var o = {};
    o[S.STORAGE_KEY] = S.normalize(next);
    return chrome.storage.local.set(o).then(function () { settings = o[S.STORAGE_KEY]; });
  }

  function saveBlocking(next) {
    var o = {};
    o[B.STORAGE_KEY] = B.normalize(next);
    return chrome.storage.local.set(o).then(function () { blocking = o[B.STORAGE_KEY]; });
  }

  function render() {
    Array.prototype.forEach.call(document.querySelectorAll('input[data-key]'), function (el) {
      el.checked = !!settings[el.getAttribute('data-key')];
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[data-bkey]'), function (el) {
      el.checked = !!blocking[el.getAttribute('data-bkey')];
      el.disabled = !settings.enabled;
    });
    $('playerTypes').value = settings.playerTypes.join('\n');
    $('twitchAdQuality').value = settings.twitchAdQuality;
  }

  function renderAllowlist() {
    $('allowlist').value = blocking.allowlist.join('\n');
  }

  function showErrors(id, errors) {
    var ul = $(id);
    ul.textContent = '';
    (errors || []).forEach(function (msg) {
      var li = document.createElement('li');
      li.textContent = msg;
      ul.appendChild(li);
    });
  }

  function flash(id, text) {
    $(id).textContent = text;
    setTimeout(function () { $(id).textContent = ''; }, 2500);
  }

  Array.prototype.forEach.call(document.querySelectorAll('input[data-key]'), function (el) {
    el.addEventListener('change', function () {
      var next = Object.assign({}, settings);
      next[el.getAttribute('data-key')] = el.checked;
      save(next).then(render, function () { render(); });
    });
  });

  $('twitchAdQuality').addEventListener('change', function () {
    save(Object.assign({}, settings, { twitchAdQuality: $('twitchAdQuality').value })).then(render, function () { render(); });
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[data-bkey]'), function (el) {
    el.addEventListener('change', function () {
      var next = Object.assign({}, blocking);
      next[el.getAttribute('data-bkey')] = el.checked;
      saveBlocking(next).catch(function () { render(); });
    });
  });

  $('al-save').addEventListener('click', function () {
    var v = B.parseAllowlistText($('allowlist').value);
    showErrors('al-errors', v.errors);
    if (!v.ok) return;
    saveBlocking(Object.assign({}, blocking, { allowlist: v.value })).then(function () {
      renderAllowlist();
      flash('al-saved', 'Saved.');
    });
  });

  // ---------------------------------------------------------------- my filters
  var ufDirty = false;

  function renderUserFilters(stored) {
    if (ufDirty) return; // keep the user's unsaved edits
    $('userfilters').value = U.toText(stored);
  }

  /** The browser's own selector parser: null when valid. */
  function domCheck(sel) {
    try { document.createDocumentFragment().querySelector(sel); return null; } catch (e) { return 'is not valid CSS'; }
  }

  $('userfilters').addEventListener('input', function () { ufDirty = true; });

  $('uf-save').addEventListener('click', function () {
    var v = U.parseText($('userfilters').value, domCheck);
    showErrors('uf-errors', v.errors);
    if (!v.ok) return;
    var o = {};
    o[U.STORAGE_KEY] = v.value;
    chrome.storage.local.set(o).then(function () {
      ufDirty = false;
      renderUserFilters(v.value);
      flash('uf-saved', 'Saved.');
    });
  });

  $('pt-save').addEventListener('click', function () {
    var list = S.parsePlayerTypeText($('playerTypes').value);
    var v = S.validatePlayerTypes(list);
    showErrors('pt-errors', v.errors);
    if (!v.ok) return;
    save(Object.assign({}, settings, { playerTypes: v.value })).then(function () {
      render();
      flash('pt-saved', 'Saved.');
    }, function (errors) { showErrors('pt-errors', errors); });
  });

  $('pt-default').addEventListener('click', function () {
    $('playerTypes').value = cfg.backupPlayerTypes.join('\n');
    showErrors('pt-errors', []);
  });

  $('reset-stats').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'reset-stats' }).then(function (r) {
      flash('reset-done', r && r.ok ? 'Statistics cleared.' : 'Could not clear statistics.');
    }, function () { flash('reset-done', 'Could not clear statistics.'); });
  });

  // ---------------------------------------------------------------- filter lists
  var Lists = ns.lists;
  var listsBusy = false;

  function fmtDate(ts) {
    if (typeof ts !== 'number' || !ts) return '';
    try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
  }

  function cell(tr, text, cls) {
    var td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }

  function renderLists(st) {
    var body = $('lists');
    body.textContent = '';
    (st && st.rows || []).forEach(function (r) {
      var tr = document.createElement('tr');
      cell(tr, r.name);
      cell(tr, r.version || '?');
      cell(tr, r.updatedAt ? fmtDate(r.updatedAt) : 'built in');
      cell(tr, typeof r.rules === 'number' ? String(r.rules) : '');
      cell(tr, r.status, r.ok ? '' : 'bad');
      body.appendChild(tr);
    });
    var m = st && st.meta;
    var last = m && m.lastCheck ? 'Last check: ' + fmtDate(m.lastCheck) + (m.lastResult ? ' – ' + m.lastResult.message : '') : 'Not checked yet.';
    $('lists-last').textContent = last;
    $('lists-update').disabled = listsBusy || !!(st && st.running);
    $('lists-reset').disabled = listsBusy || !(m && m.source === 'updated');
  }

  function refreshLists() {
    return chrome.runtime.sendMessage({ type: 'as-lists-status' }).then(renderLists, function () {
      // Background not answering: show the built-in lists from the package.
      return fetch(chrome.runtime.getURL('rules/build-info.json')).then(function (r) { return r.json(); }).then(function (info) {
        renderLists({ rows: Lists.statusRows(null, Lists.packagedLists(info)), meta: null });
      }, function () {});
    });
  }

  function listsAction(type, busyText) {
    listsBusy = true;
    $('lists-update').disabled = true;
    $('lists-reset').disabled = true;
    $('lists-result').textContent = busyText;
    chrome.runtime.sendMessage({ type: type }).then(function (r) {
      $('lists-result').textContent = r && r.message ? r.message : 'Done.';
    }, function (e) {
      $('lists-result').textContent = 'Failed: ' + (e && e.message ? e.message : e);
    }).then(function () {
      listsBusy = false;
      return refreshLists();
    });
  }

  $('lists-update').addEventListener('click', function () { listsAction('as-lists-update-now', 'Downloading and converting…'); });
  $('lists-reset').addEventListener('click', function () { listsAction('as-lists-reset', 'Switching to the built-in lists…'); });
  refreshLists();

  // ---------------------------------------------------------------- support
  var donate = ns.donate;
  if (donate && donate.url) {
    $('support-link').href = donate.url;
    $('support-revolut').hidden = false;
  }
  function showAddress(id, address, note) {
    if (!address) return;
    $(id + '-address').textContent = address;
    $(id + '-note').textContent = note;
    $('support-' + id).hidden = false;
    $(id + '-copy').addEventListener('click', function () {
      navigator.clipboard.writeText(address).then(function () {
        flash(id + '-copied', 'Copied.');
      }, function () { flash(id + '-copied', 'Could not copy; select the address and copy it.'); });
    });
  }
  if (donate) {
    showAddress('usdc', donate.usdcErc20, donate.usdcNote);
    showAddress('btc', donate.btc, donate.btcNote);
  }
  if (!donate || (!donate.url && !donate.usdcErc20 && !donate.btc)) $('support').hidden = true;

  $('known').textContent = cfg.knownPlayerTypes.join(', ');
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.storage.local.get([S.STORAGE_KEY, B.STORAGE_KEY, U.STORAGE_KEY]).then(function (r) {
    settings = S.normalize(r[S.STORAGE_KEY]);
    blocking = B.normalize(r[B.STORAGE_KEY]);
    render();
    renderAllowlist();
    renderUserFilters(r[U.STORAGE_KEY]);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes[S.STORAGE_KEY]) settings = S.normalize(changes[S.STORAGE_KEY].newValue);
    if (changes[B.STORAGE_KEY]) {
      blocking = B.normalize(changes[B.STORAGE_KEY].newValue);
      renderAllowlist();
    }
    if (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY]) render();
    if (changes[U.STORAGE_KEY]) renderUserFilters(changes[U.STORAGE_KEY].newValue);
    if (changes[Lists.META_KEY] && !listsBusy) refreshLists();
  });
})();
