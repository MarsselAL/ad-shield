/* Popup: status for the active tab, on/off switch, counts, last event. */
(function () {
  'use strict';
  var ns = globalThis.__TAS__;
  var S = ns.settings;
  var Stats = ns.stats;
  var $ = function (id) { return document.getElementById(id); };
  var activeTab = null;
  var settings = S.defaults();

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ''; }
  }

  function setCounts(prefix, s) {
    ['detected', 'backup', 'stripped', 'standalone', 'failures'].forEach(function (k) {
      $(prefix + '-' + k).textContent = String(s[k]);
    });
  }

  function tabStatus(tabId) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'get-status' }, { frameId: 0 }, function (resp) {
          void chrome.runtime.lastError; // no receiver = scripts not loaded in this tab
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function render(state, status) {
    var degraded = !!(state && state.tab.degraded) || !!(status && status.degraded && status.degraded.length);
    var st = Stats.popupStatus({
      url: activeTab && activeTab.url,
      enabled: settings.enabled,
      hooked: !!(status && status.pageHooked),
      degraded: degraded
    });
    $('status-text').textContent = st.text;
    $('status-detail').textContent = st.detail;
    $('status-dot').className = 'dot ' + st.level;
    $('reload').hidden = !st.reload;
    if (state) {
      setCounts('t', state.tab.stats);
      setCounts('l', state.lifetime);
      $('last-event').textContent = state.tab.lastEvent ? fmtTime(state.tab.lastEvent.at) + ' – ' + state.tab.lastEvent.text : 'No events yet.';
    }
  }

  function refresh() {
    return chrome.storage.local.get(S.STORAGE_KEY).then(function (r) {
      settings = S.normalize(r[S.STORAGE_KEY]);
      $('enabled').checked = settings.enabled;
      if (!activeTab || typeof activeTab.id !== 'number') { render(null, null); return; }
      return Promise.all([
        chrome.runtime.sendMessage({ type: 'popup-get-state', tabId: activeTab.id }).catch(function () { return null; }),
        tabStatus(activeTab.id)
      ]).then(function (res) { render(res[0], res[1]); });
    });
  }

  $('enabled').addEventListener('change', function (e) {
    var next = Object.assign({}, settings, { enabled: e.target.checked });
    var o = {};
    o[S.STORAGE_KEY] = next;
    chrome.storage.local.set(o).then(refresh);
  });

  $('reload').addEventListener('click', function () {
    if (activeTab && typeof activeTab.id === 'number') chrome.tabs.reload(activeTab.id);
    window.close();
  });

  $('open-options').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    return refresh();
  }).catch(function () { render(null, null); });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'session' || (area === 'local')) refresh();
  });
})();
