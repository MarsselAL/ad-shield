/* Options page. Toggles save immediately; the playerType list saves after validation. */
(function () {
  'use strict';
  var ns = globalThis.__TAS__;
  var S = ns.settings;
  var cfg = ns.config;
  var $ = function (id) { return document.getElementById(id); };
  var settings = S.defaults();

  function save(next) {
    var v = S.validate(next);
    if (!v.ok) return Promise.reject(v.errors);
    var o = {};
    o[S.STORAGE_KEY] = S.normalize(next);
    return chrome.storage.local.set(o).then(function () { settings = o[S.STORAGE_KEY]; });
  }

  function render() {
    Array.prototype.forEach.call(document.querySelectorAll('input[data-key]'), function (el) {
      el.checked = !!settings[el.getAttribute('data-key')];
    });
    $('playerTypes').value = settings.playerTypes.join('\n');
  }

  function showErrors(errors) {
    var ul = $('pt-errors');
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
      save(next).catch(function () { render(); });
    });
  });

  $('pt-save').addEventListener('click', function () {
    var list = S.parsePlayerTypeText($('playerTypes').value);
    var v = S.validatePlayerTypes(list);
    showErrors(v.errors);
    if (!v.ok) return;
    save(Object.assign({}, settings, { playerTypes: v.value })).then(function () {
      render();
      flash('pt-saved', 'Saved.');
    }, showErrors);
  });

  $('pt-default').addEventListener('click', function () {
    $('playerTypes').value = cfg.backupPlayerTypes.join('\n');
    showErrors([]);
  });

  $('reset-stats').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'reset-stats' }).then(function (r) {
      flash('reset-done', r && r.ok ? 'Statistics cleared.' : 'Could not clear statistics.');
    }, function () { flash('reset-done', 'Could not clear statistics.'); });
  });

  $('known').textContent = cfg.knownPlayerTypes.join(', ');
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.storage.local.get(S.STORAGE_KEY).then(function (r) {
    settings = S.normalize(r[S.STORAGE_KEY]);
    render();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[S.STORAGE_KEY]) {
      settings = S.normalize(changes[S.STORAGE_KEY].newValue);
      render();
    }
  });
})();
