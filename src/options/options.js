/*
 * Options page. Toggles save immediately; the playerType list and the allowlist save after
 * validation. Twitch/master settings live under "settings" (src/shared/settings.js), the
 * all-sites settings and allowlist under "blocking" (src/shared/blocking.js).
 */
(function () {
  'use strict';
  var ns = globalThis.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
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

  function renderLists(info) {
    var ul = $('lists');
    var names = { easylist: 'EasyList (ads)', easyprivacy: 'EasyPrivacy (trackers)', 'easylist-cookie': 'EasyList Cookie List' };
    Object.keys(names).forEach(function (k) {
      var l = info && info.lists && info.lists[k];
      if (!l) return;
      var li = document.createElement('li');
      li.textContent = names[k] + ' – version ' + l.version + ': ' + l.networkConverted + ' network and ' +
        l.cosmeticConverted + ' cosmetic filters used, ' + l.skippedTotal + ' skipped (not expressible in Chrome’s rule format).';
      ul.appendChild(li);
    });
  }
  fetch(chrome.runtime.getURL('rules/build-info.json')).then(function (r) { return r.json(); }).then(renderLists, function () {});

  $('known').textContent = cfg.knownPlayerTypes.join(', ');
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.storage.local.get([S.STORAGE_KEY, B.STORAGE_KEY]).then(function (r) {
    settings = S.normalize(r[S.STORAGE_KEY]);
    blocking = B.normalize(r[B.STORAGE_KEY]);
    render();
    renderAllowlist();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes[S.STORAGE_KEY]) settings = S.normalize(changes[S.STORAGE_KEY].newValue);
    if (changes[B.STORAGE_KEY]) {
      blocking = B.normalize(changes[B.STORAGE_KEY].newValue);
      renderAllowlist();
    }
    if (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY]) render();
  });
})();
