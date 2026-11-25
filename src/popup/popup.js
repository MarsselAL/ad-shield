/*
 * Popup: two panels side by side (Chrome allows popups up to 800x600; this one is about 744 wide).
 * Left: master switch, per-site switch (allowlist), counts for the current page, quick actions and
 * the Twitch status/counts on Twitch tabs. Right: "Support AdBrake", always fully visible.
 * Counts: chrome.declarativeNetRequest.getMatchedRules({tabId, minTimeStamp}) (needs the
 * declarativeNetRequestFeedback permission) gives the DNR matches of this tab since the page
 * started (the page script reports performance.timeOrigin); "banners handled" adds the page's
 * hidden-banner and autoconsent counts kept by the background. getMatchedRules is limited to 20
 * calls per 10 minutes outside user gestures, so it runs once per popup open and at most every
 * 5 s while the popup stays open.
 * "Hide an element on this page" (web pages with blocking on) injects the element picker
 * (src/shared/selector.js + src/content/picker.js) into the tab's top frame and closes the popup.
 * Support panel: the tip link from src/shared/donate.js with its QR code ("Pay with phone"), and
 * a "Crypto" switch between the USDC and BTC addresses from donate.js (QR code, shortened address,
 * Copy copies the full address, the network warning). Hidden when donate.js sets nothing.
 * Occasional support note (src/shared/supportprompt.js): when due, the support panel glows once
 * and shows a short thank-you line; nothing covers the popup.
 * Layout, left panel: header (icon, name, Settings button), the big power button (#enabled, the
 * master switch) with the "Ad Blocking On/Off/Paused" line, the page counts, the "This website"
 * card (its chevron opens the per-site switch #site-on), quick actions ("Hide an element" and
 * "Allowlist site" / "Remove from allowlist", which flips the same allowlist entry as #site-on).
 */
(function () {
  'use strict';
  var ns = globalThis.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
  var Stats = ns.stats;
  var $ = function (id) { return document.getElementById(id); };
  var activeTab = null;
  var settings = S.defaults();
  var blocking = B.defaults();
  var lastCounts = 0;
  var countTimer = null;

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ''; }
  }

  function tabUrl() { return activeTab && activeTab.url ? String(activeTab.url) : ''; }

  // ---------------------------------------------------------------- general part
  function renderSite() {
    var site = B.popupSite({ url: tabUrl(), enabled: settings.enabled, allowlist: blocking.allowlist });
    $('site-host').textContent = site.host || 'This page';
    $('site-detail').textContent = site.detail;
    $('site-on').checked = site.on;
    $('site-on').disabled = !site.web || !settings.enabled;
    $('pick').hidden = !(site.web && site.on && settings.enabled);
    // Status line and quick actions
    var word = !settings.enabled ? 'Off' : (site.web && !site.on ? 'Paused' : 'On');
    $('state-word').textContent = word;
    $('state-word').className = 'state-word ' + (word === 'On' ? 'on' : 'off');
    $('site-ico').className = 'site-ico ' + (site.on && settings.enabled ? 'on' : 'off');
    var canAllow = site.web && settings.enabled;
    $('allow-toggle').hidden = !canAllow;
    $('allow-label').textContent = site.on ? 'Allowlist site' : 'Remove from allowlist';
    $('allow-toggle').title = site.on ? 'Turn blocking off on this site' : 'Turn blocking back on for this site';
    $('allow-icon').setAttribute('href', site.on ? '#i-list-plus' : '#i-list-minus');
    $('actions').hidden = $('pick').hidden && $('allow-toggle').hidden;
  }

  function setCount(id, n) { $(id).textContent = typeof n === 'number' ? String(n) : '–'; }

  function refreshCounts() {
    if (!activeTab || typeof activeTab.id !== 'number') return Promise.resolve();
    var now = Date.now();
    if (now - lastCounts < 5000) {
      if (!countTimer) countTimer = setTimeout(function () { countTimer = null; refreshCounts(); }, 5000 - (now - lastCounts));
      return Promise.resolve();
    }
    lastCounts = now;
    var key = 'page:' + activeTab.id;
    return chrome.storage.session.get(key).then(function (r) {
      var page = r[key] || { t: 0, hidden: 0, rejected: 0 };
      var filter = { tabId: activeTab.id };
      if (page.t > 0) filter.minTimeStamp = page.t;
      return chrome.declarativeNetRequest.getMatchedRules(filter).then(function (res) {
        var c = B.countMatches(res && res.rulesMatchedInfo);
        setCount('g-ads', c.ads);
        setCount('g-trackers', c.trackers);
        setCount('g-cookies', c.cookies);
        setCount('g-banners', c.banners + (page.hidden || 0) + (page.rejected || 0));
        $('counts-note').textContent = '';
        supportNote(c.ads, page.t);
      }, function () {
        ['g-ads', 'g-trackers', 'g-cookies'].forEach(function (id) { setCount(id, null); });
        setCount('g-banners', (page.hidden || 0) + (page.rejected || 0));
        $('counts-note').textContent = 'Request counts are unavailable for a few minutes (Chrome limits how often they can be read).';
      });
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- Twitch part
  function setTwitchCounts(prefix, s) {
    ['detected', 'backup', 'stripped', 'standalone', 'failures'].forEach(function (k) {
      $(prefix + '-' + k).textContent = String(s[k]);
    });
  }

  function tabStatus(tabId) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'get-status' }, { frameId: 0 }, function (resp) {
          void chrome.runtime.lastError; // no receiver = scripts not loaded in this tab
          resolve(resp && typeof resp === 'object' && 'pageHooked' in resp ? resp : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function renderTwitch(state, status) {
    var degraded = !!(state && state.tab.degraded) || !!(status && status.degraded && status.degraded.length);
    var st = Stats.popupStatus({
      url: tabUrl(),
      enabled: settings.enabled && !B.isAllowlisted(B.popupSite({ url: tabUrl() }).hostname, blocking.allowlist),
      hooked: !!(status && status.pageHooked),
      degraded: degraded
    });
    $('twitch').hidden = st.key === 'not-twitch';
    $('status-text').textContent = st.text;
    $('status-detail').textContent = st.detail;
    $('status-dot').className = 'dot ' + st.level;
    $('reload').hidden = !st.reload;
    if (state) {
      setTwitchCounts('t', state.tab.stats);
      setTwitchCounts('l', state.lifetime);
      $('last-event').textContent = state.tab.lastEvent ? fmtTime(state.tab.lastEvent.at) + ' – ' + state.tab.lastEvent.text : 'No events yet.';
    }
  }

  function refreshTwitch() {
    if (!activeTab || typeof activeTab.id !== 'number' || Stats.popupStatus({ url: tabUrl() }).key === 'not-twitch') {
      $('twitch').hidden = true;
      return Promise.resolve();
    }
    return Promise.all([
      chrome.runtime.sendMessage({ type: 'popup-get-state', tabId: activeTab.id }).catch(function () { return null; }),
      tabStatus(activeTab.id)
    ]).then(function (res) { renderTwitch(res[0], res[1]); });
  }

  function readSettings() {
    return chrome.storage.local.get([S.STORAGE_KEY, B.STORAGE_KEY]).then(function (r) {
      settings = S.normalize(r[S.STORAGE_KEY]);
      blocking = B.normalize(r[B.STORAGE_KEY]);
      $('enabled').checked = settings.enabled;
      renderSite();
    });
  }

  // ---------------------------------------------------------------- events
  $('enabled').addEventListener('change', function (e) {
    var next = Object.assign({}, settings, { enabled: e.target.checked });
    var o = {};
    o[S.STORAGE_KEY] = next;
    chrome.storage.local.set(o);
  });

  /** Blocking on (true) or off (false) for the current site: edits the allowlist. */
  function setSiteBlocking(on) {
    var host = B.popupSite({ url: tabUrl() }).hostname;
    var next = Object.assign({}, blocking, { allowlist: B.setSiteAllowed(blocking.allowlist, host, !on) });
    var o = {};
    o[B.STORAGE_KEY] = next;
    chrome.storage.local.set(o).then(function () { $('site-reload').hidden = false; });
  }

  $('site-on').addEventListener('change', function (e) { setSiteBlocking(e.target.checked); });

  $('allow-toggle').addEventListener('click', function () {
    var site = B.popupSite({ url: tabUrl(), enabled: settings.enabled, allowlist: blocking.allowlist });
    if (site.web) setSiteBlocking(!site.on);
  });

  $('site-toggle').addEventListener('click', function () {
    var open = $('site-panel').hidden;
    $('site-panel').hidden = !open;
    $('site-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function reloadTab() {
    if (activeTab && typeof activeTab.id === 'number') chrome.tabs.reload(activeTab.id);
    window.close();
  }
  $('reload').addEventListener('click', reloadTab);
  $('site-reload').addEventListener('click', reloadTab);

  $('pick').addEventListener('click', function () {
    if (!activeTab || typeof activeTab.id !== 'number') return;
    chrome.scripting.executeScript({
      target: { tabId: activeTab.id, frameIds: [0] },
      files: ['src/shared/selector.js', 'src/content/picker.js']
    }).then(function () { window.close(); }, function (e) {
      $('pick-error').hidden = false;
      $('pick-error').textContent = 'Cannot open the picker on this page' + (e && e.message ? ' (' + e.message + ')' : '') + '.';
    });
  });

  $('open-options').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ---------------------------------------------------------------- support
  // The tip link from src/shared/donate.js with its QR code, and the USDC / BTC addresses with
  // theirs (static SVGs made by tools/make_qr.py). Values are set at runtime from donate.js only.
  var donate = ns.donate || {};

  /** "0xD26B…b18A": the start and end people compare; the full address is copied and in the title. */
  function shortAddress(a) {
    a = String(a || '');
    return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }

  var coins = [
    { id: 'usdc', name: 'USDC', address: donate.usdcErc20, note: donate.usdcNote },
    { id: 'btc', name: 'Bitcoin', address: donate.btc, note: donate.btcNote }
  ].filter(function (c) { return !!c.address; });
  var copyTimers = {};

  function selectCoin(id, focus) {
    coins.forEach(function (c) {
      var on = c.id === id;
      $('tab-' + c.id).setAttribute('aria-selected', on ? 'true' : 'false');
      $('tab-' + c.id).tabIndex = on ? 0 : -1;
      $('coin-' + c.id).hidden = !on;
    });
    if (focus) { try { $('tab-' + id).focus(); } catch (e) {} }
  }

  function copyAddress(c) {
    var label = $(c.id + '-copy-label');
    var btn = $(c.id + '-copy');
    return navigator.clipboard.writeText(c.address).then(function () {
      label.textContent = 'Copied ✓';
      btn.className = 'copy copied';
    }, function () {
      label.textContent = 'Select it';
      btn.className = 'copy';
    }).then(function () {
      if (copyTimers[c.id]) clearTimeout(copyTimers[c.id]);
      copyTimers[c.id] = setTimeout(function () {
        copyTimers[c.id] = null;
        label.textContent = 'Copy';
        btn.className = 'copy';
      }, 1500);
    });
  }

  coins.forEach(function (c, i) {
    $(c.id + '-address').textContent = shortAddress(c.address);
    $(c.id + '-address').title = c.address;
    $(c.id + '-address').setAttribute('aria-label', c.name + ' address ' + c.address);
    $(c.id + '-note').textContent = c.note || '';
    $('tab-' + c.id).hidden = false;
    $('tab-' + c.id).addEventListener('click', function () { selectCoin(c.id, false); });
    $('tab-' + c.id).addEventListener('keydown', function (e) {
      var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0);
      if (!step) return;
      e.preventDefault();
      selectCoin(coins[(i + step + coins.length) % coins.length].id, true);
    });
    $(c.id + '-copy').addEventListener('click', function () { copyAddress(c); });
  });
  if (coins.length) {
    selectCoin(coins[0].id, false);
    $('support-crypto').hidden = false;
  }

  if (donate.url) {
    $('support-link').href = donate.url;
    $('support-revolut').hidden = false;
    $('support-link').addEventListener('click', function (e) {
      e.preventDefault();
      chrome.tabs.create({ url: donate.url }).then(function () { window.close(); }, function () {});
    });
  }
  var hasSupport = !!(donate.url || coins.length);
  $('support').hidden = !hasSupport;
  $('layout').className = hasSupport ? 'layout' : 'layout single';

  // ---------------------------------------------------------------- occasional support note
  // src/shared/supportprompt.js decides; this adds the page's ads count to a lower-bound total
  // (no extra getMatchedRules calls). When due, the support panel glows once and shows a short
  // thank-you line; "Don't remind me" turns the note off (as the settings switch does).
  var SP = ns.supportPrompt;
  var promptChecked = false;

  function updateState(fn) {
    return chrome.storage.local.get(SP.STATE_KEY).then(function (r) {
      var o = {};
      o[SP.STATE_KEY] = fn(r[SP.STATE_KEY]);
      return chrome.storage.local.set(o);
    }).catch(function () {});
  }

  function highlightSupport(count) {
    $('prompt-text').textContent = SP.thanks(count);
    $('support-prompt').hidden = false;
    $('support').className = 'panel support highlight';
  }

  function supportNote(ads, loadedAt) {
    if (!SP || !activeTab || typeof activeTab.id !== 'number') return Promise.resolve();
    var key = SP.pageKey(activeTab.id, tabUrl(), loadedAt);
    return chrome.storage.local.get([SP.SEEN_KEY, SP.INSTALL_KEY, SP.STATE_KEY]).then(function (r) {
      var now = Date.now();
      var seen = SP.accumulate(r[SP.SEEN_KEY], key, ads);
      var o = {};
      o[SP.SEEN_KEY] = seen;
      var installedAt = r[SP.INSTALL_KEY];
      if (!installedAt) { installedAt = now; o[SP.INSTALL_KEY] = now; } // installed before this key existed
      if (!promptChecked) {
        promptChecked = true;
        var version = chrome.runtime.getManifest().version;
        var d = SP.decide({ now: now, installedAt: installedAt, seen: seen, state: r[SP.STATE_KEY],
          version: version, hasLink: !!donate.url });
        var st = SP.normalizeState(r[SP.STATE_KEY]);
        st.version = version;
        if (d.show) {
          st = SP.shown(st, now, d.milestone);
          highlightSupport(d.count);
        }
        o[SP.STATE_KEY] = st;
      }
      return chrome.storage.local.set(o);
    }).catch(function () {});
  }

  if (SP) {
    $('prompt-never').addEventListener('click', function () {
      $('support-prompt').hidden = true;
      $('support').className = 'panel support';
      updateState(function (st) { return SP.never(st); });
    });
  }

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    return readSettings().then(function () { return Promise.all([refreshCounts(), refreshTwitch()]); });
  }).catch(function () { renderSite(); });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY])) readSettings().then(refreshTwitch);
    if (area === 'session') {
      refreshTwitch();
      if (activeTab && changes['page:' + activeTab.id]) refreshCounts();
    }
  });
})();
