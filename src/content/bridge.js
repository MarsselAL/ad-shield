/*
 * Bridge (ISOLATED world, document_start). Loaded after config.js, settings.js, logger.js,
 * frame.js, stats.js and cosmetic.js.
 *
 *  - reads settings from chrome.storage.local and sends them to the MAIN-world page script
 *    (DOM CustomEvent, JSON string payload), again on every change;
 *  - forwards page/worker events to the background (stats, badge, popup "last event");
 *  - shows the optional "Ad blocked" toast in the player;
 *  - drives the cosmetic module;
 *  - answers the popup's status question for this tab.
 * Switched off (settings.enabled === false): no toast (a visible one is hidden), no cosmetic
 * DOM changes (cosmetic.setEnabled(false) undoes them), no events forwarded to the stats.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (root.__tas_bridge_installed__) return;
  root.__tas_bridge_installed__ = true;

  var cfg = ns.config;
  var S = ns.settings;
  var Stats = ns.stats;
  var frame = ns.frame;
  var isTop = frame.isTopFrame(root);
  if (!frame.shouldRunInFrame(root.location.hostname, root.location.pathname, isTop)) return;

  var doc = root.document;
  var settings = S.defaults();
  var log = ns.createLogger('bridge', function () { return !!settings.debug; });
  var pageHooked = false;
  var settingsLoaded = false; // stored settings read; before that only defaults are known
  var degraded = {};
  var lastChannel = null;

  function send(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(function () { /* background asleep / reloading */ });
    } catch (e) { /* extension context invalidated after update/disable */ }
  }

  function toPage(msg) {
    try { doc.dispatchEvent(new CustomEvent(cfg.events.toPage, { detail: JSON.stringify(msg) })); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- cosmetic
  var cosmetic = ns.cosmetic.createCosmetic({
    doc: doc,
    log: log,
    onHidden: function () { send({ type: 'tab-event', name: 'standalone-ad-hidden', data: {} }); }
  });
  cosmetic.setEnabled(settings.enabled && settings.hideStandaloneAds);

  function applySettings(raw) {
    settings = S.normalize(raw);
    settingsLoaded = true;
    toPage({ type: 'settings', settings: settings });
    cosmetic.setEnabled(settings.enabled && settings.hideStandaloneAds);
    if (!settings.enabled || !settings.noticeOnAd) hideToast();
  }

  try {
    chrome.storage.local.get(S.STORAGE_KEY).then(function (r) { applySettings(r && r[S.STORAGE_KEY]); }, function () {});
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[S.STORAGE_KEY]) applySettings(changes[S.STORAGE_KEY].newValue);
    });
  } catch (e) {
    log.warn('storage unavailable', e && e.message);
  }

  // ---------------------------------------------------------------- toast
  var toastEl = null, toastTimer = null;
  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    try { if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl); } catch (e) { /* ignore */ }
  }
  function showToast(text) {
    if (!isTop && !/(^|\.)player\.twitch\.tv$/.test(root.location.hostname)) return;
    try {
      var host = doc.querySelector(cfg.player.playerContainerSelector) || doc.body;
      if (!host) return;
      if (!toastEl) {
        toastEl = doc.createElement('div');
        toastEl.setAttribute('role', 'status');
        var st = toastEl.style;
        st.position = host === doc.body ? 'fixed' : 'absolute';
        st.top = '10px';
        st.left = '10px';
        st.zIndex = '2147483000';
        st.padding = '6px 10px';
        st.borderRadius = '6px';
        st.font = '12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif';
        st.color = '#fff';
        st.background = 'rgba(20, 20, 24, 0.82)';
        st.pointerEvents = 'none';
        st.transition = 'opacity 0.3s';
        st.opacity = '0';
      }
      if (toastEl.parentNode !== host) host.appendChild(toastEl);
      toastEl.textContent = text;
      toastEl.style.opacity = '1';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 4000);
    } catch (e) {
      log.debug('toast failed', e && e.message);
    }
  }

  // ---------------------------------------------------------------- page events
  doc.addEventListener(cfg.events.toBridge, function (e) {
    var msg;
    try { msg = JSON.parse(e.detail); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      pageHooked = true;
      // Only real stored settings; applySettings sends them once chrome.storage answers.
      if (settingsLoaded) toPage({ type: 'settings', settings: settings });
      send({ type: 'tab-hello', top: isTop, version: msg.version });
      return;
    }
    if (msg.type === 'event' && typeof msg.name === 'string') {
      // Late events from work that was in flight when the switch flipped: ignore them.
      if (!settings.enabled) return;
      var data = msg.data && typeof msg.data === 'object' ? msg.data : {};
      if (data.channel) lastChannel = String(data.channel);
      if (msg.name === 'degraded' && data.channel) degraded[data.channel] = true;
      if (Stats.isCounted(msg.name) || msg.name === 'degraded' || msg.name === 'ad-end') {
        send({ type: 'tab-event', name: msg.name, data: data });
      }
      if (settings.enabled && settings.noticeOnAd) {
        var t = Stats.toastText(msg.name);
        if (t) showToast(t);
      }
    }
  });
  toPage({ type: 'ping' });

  // ---------------------------------------------------------------- popup status
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'get-status' || sender.id !== chrome.runtime.id) return;
      sendResponse({
        pageHooked: pageHooked,
        degraded: Object.keys(degraded),
        channel: lastChannel,
        url: root.location.href
      });
    });
  } catch (e) { /* ignore */ }
})(typeof globalThis !== 'undefined' ? globalThis : this);
