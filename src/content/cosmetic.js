/*
 * Cosmetic blocking (ISOLATED world). Hides, mutes and pauses standalone ad <video> elements
 * that Twitch shows beside the player / in chat since ~July 2026 (docs/research-github.md
 * item 4, docs/research-technique.md §7). Selectors and hosts live in src/config.js.
 *
 * Cost control:
 *  - a CSS rule hides matching videos with no JS work at all;
 *  - a capture-phase 'play' listener catches any ad video that starts playing (mute + pause);
 *  - a MutationObserver only schedules a scan when an added node is or contains a <video>, or
 *    a <video>'s src changes; scans are throttled (cfg.cosmetic.throttleMs).
 * It only ever touches <video> elements whose source is an ad host (and configured overlay
 * selectors): never chat, channel points or navigation.
 * setEnabled(false) removes the CSS rule, the listeners and the observer, and gives hidden
 * videos their previous inline display back (they stay muted and paused).
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) return;
  var cfg = ns.config;
  var cc = cfg.cosmetic;

  function srcIsAdHost(src) {
    var s = String(src || '');
    if (!/^https?:/i.test(s)) return false;
    var host;
    try { host = new URL(s).hostname.toLowerCase(); } catch (e) { return false; }
    for (var i = 0; i < cc.adVideoHosts.length; i++) {
      var h = cc.adVideoHosts[i];
      if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
    }
    return false;
  }

  function isAdVideo(v) {
    if (!v || v.nodeName !== 'VIDEO') return false;
    if (srcIsAdHost(v.currentSrc) || srcIsAdHost(v.getAttribute('src'))) return true;
    var sources = v.getElementsByTagName('source');
    for (var i = 0; i < sources.length; i++) {
      if (srcIsAdHost(sources[i].getAttribute('src'))) return true;
    }
    return false;
  }

  function createCosmetic(opts) {
    var doc = opts.doc;
    var onHidden = opts.onHidden || function () {};
    var log = opts.log;
    var enabled = false;
    var observer = null;
    var styleEl = null;
    var scheduled = null;
    var handled = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var hidden = []; // { v, display, priority } for restoring on setEnabled(false)

    function neutralize(v) {
      try {
        if (handled && handled.has(v)) {
          if (!v.paused) v.pause();
          return;
        }
        if (handled) handled.add(v);
        v.muted = true;
        v.autoplay = false;
        try { v.pause(); } catch (e) { /* ignore */ }
        var st = v.style;
        hidden.push({
          v: v,
          display: typeof st.getPropertyValue === 'function' ? st.getPropertyValue('display') : '',
          priority: typeof st.getPropertyPriority === 'function' ? st.getPropertyPriority('display') : ''
        });
        st.setProperty('display', 'none', 'important');
        onHidden(v);
      } catch (e) {
        log.debug('cosmetic neutralize failed', e && e.message);
      }
    }

    function scan() {
      scheduled = null;
      if (!enabled) return;
      try {
        var vids = doc.getElementsByTagName('video');
        for (var i = 0; i < vids.length; i++) if (isAdVideo(vids[i])) neutralize(vids[i]);
      } catch (e) {
        log.debug('cosmetic scan failed', e && e.message);
      }
    }

    function schedule() {
      if (scheduled !== null || !enabled) return;
      scheduled = setTimeout(scan, cc.throttleMs);
    }

    function nodeHasVideo(n) {
      if (n.nodeType !== 1) return false;
      if (n.nodeName === 'VIDEO' || n.nodeName === 'SOURCE') return true;
      return n.getElementsByTagName ? n.getElementsByTagName('video').length > 0 : false;
    }

    function onMutations(muts) {
      if (scheduled !== null) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') {
          if (m.target.nodeName === 'VIDEO' || m.target.nodeName === 'SOURCE') { schedule(); return; }
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (nodeHasVideo(added[j])) { schedule(); return; }
        }
      }
    }

    function onPlay(e) {
      if (enabled && isAdVideo(e.target)) neutralize(e.target);
    }

    function css() {
      var sels = cc.adVideoSelectors.concat(cc.overlaySelectors);
      return sels.length ? sels.join(',\n') + ' { display: none !important; }' : '';
    }

    function setEnabled(on) {
      on = !!on;
      if (on === enabled) return;
      enabled = on;
      if (on) {
        try {
          styleEl = doc.createElement('style');
          styleEl.textContent = css();
          (doc.head || doc.documentElement).appendChild(styleEl);
        } catch (e) { styleEl = null; }
        doc.addEventListener('play', onPlay, true);
        observer = new MutationObserver(onMutations);
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        schedule();
      } else {
        if (observer) { observer.disconnect(); observer = null; }
        doc.removeEventListener('play', onPlay, true);
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        styleEl = null;
        if (scheduled !== null) { clearTimeout(scheduled); scheduled = null; }
        restoreHidden();
      }
    }

    function restoreHidden() {
      hidden.forEach(function (h) {
        try {
          if (h.display) h.v.style.setProperty('display', h.display, h.priority || '');
          else h.v.style.removeProperty('display');
        } catch (e) { /* ignore */ }
      });
      hidden = [];
      handled = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    }

    return { setEnabled: setEnabled, scan: scan };
  }

  ns.cosmetic = { createCosmetic: createCosmetic, srcIsAdHost: srcIsAdHost, isAdVideo: isAdVideo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
