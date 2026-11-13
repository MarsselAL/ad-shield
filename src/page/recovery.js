/*
 * Player recovery / health (MAIN world). docs/research-technique.md §5.
 *
 * After every playlist switch (native <-> backup <-> stripped) and every ad end, watch the main
 * <video> for cfg.recovery.watchWindowMs. If currentTime does not advance for
 * stallThresholdMs while it should be playing:
 *   step 1: pause/play ("soft kick")
 *   step 2: hard player reload through the React fiber setSrc approach, keeping the
 *           localStorage quality/volume/muted/lowLatency values across the reload
 *   then give up for this switch (no loops).
 * Hard reloads are rate-limited per channel (maxReloadsPerWindow per reloadWindowMs). Over
 * the limit, the channel is switched to strip-only mode for the rest of the page session
 * (onDegrade) and no further reloads happen there.
 * There is no timer unless a watch is active. Every step is wrapped in try/catch.
 * opts.isEnabled() false (extension switched off): events are ignored and a running watch is
 * dropped on its next tick, so nothing touches the player.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) throw new Error('[TAS] recovery.js needs config.js first');

  /** Sliding-window limiter: allow() returns false once max calls happened within windowMs. */
  function createReloadLimiter(max, windowMs, now) {
    var history = {};
    return {
      allow: function (key) {
        var t = now();
        var h = (history[key] || []).filter(function (x) { return t - x < windowMs; });
        if (h.length >= max) { history[key] = h; return false; }
        h.push(t);
        history[key] = h;
        return true;
      },
      count: function (key) {
        var t = now();
        return (history[key] || []).filter(function (x) { return t - x < windowMs; }).length;
      }
    };
  }

  /** Walk the React fiber tree under #root for the player instance and the player state. */
  function findPlayerAndState(doc, cfg) {
    var rootEl = doc.querySelector(cfg.player.rootSelector);
    if (!rootEl) return null;
    var fiber = null;
    try {
      if (rootEl._reactRootContainer && rootEl._reactRootContainer._internalRoot) {
        fiber = rootEl._reactRootContainer._internalRoot.current;
      } else {
        var keys = Object.keys(rootEl);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('__reactContainer') === 0) { fiber = rootEl[keys[i]]; break; }
        }
      }
    } catch (e) { return null; }
    if (!fiber) return null;
    var player = null, state = null;
    var stack = [fiber];
    var visited = 0;
    while (stack.length && visited < 50000 && !(player && state)) {
      var node = stack.pop();
      visited++;
      if (!node) continue;
      var sn = node.stateNode;
      if (sn && typeof sn === 'object') {
        try {
          if (!player && sn.setPlayerActive && sn.props && sn.props.mediaPlayerInstance) {
            var mpi = sn.props.mediaPlayerInstance;
            player = mpi.playerInstance || mpi;
          }
          if (!state && sn.setSrc && sn.setInitialPlaybackSettings) state = sn;
        } catch (e) { /* cross-realm or getter error: skip */ }
      }
      if (node.sibling) stack.push(node.sibling);
      if (node.child) stack.push(node.child);
    }
    return player || state ? { player: player, state: state } : null;
  }

  /**
   * @param opts { cfg, log, doc, win, now, setInterval, clearInterval, emit(name,data),
   *               onDegrade(channel), findPlayerAndState?, isEnabled? (default: always on) }
   */
  function createRecovery(opts) {
    var cfg = opts.cfg;
    var rc = cfg.recovery;
    var log = opts.log;
    var doc = opts.doc;
    var win = opts.win;
    var now = opts.now || function () { return Date.now(); };
    var setIv = opts.setInterval || function (f, ms) { return setInterval(f, ms); };
    var clearIv = opts.clearInterval || function (id) { clearInterval(id); };
    var emit = opts.emit || function () {};
    var isEnabled = opts.isEnabled || function () { return true; };
    var finder = opts.findPlayerAndState || function () { return findPlayerAndState(doc, cfg); };
    var limiter = createReloadLimiter(rc.maxReloadsPerWindow, rc.reloadWindowMs, now);
    var degraded = {};
    var watch = null;
    var timer = null;

    function findVideo() {
      var vids = doc.querySelectorAll(cfg.player.videoSelector);
      var fallback = null;
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        var src = String(v.currentSrc || v.src || '');
        if (src.indexOf('blob:') === 0) return v; // the MSE player video
        if (!fallback && !src) fallback = v;
      }
      return fallback;
    }

    function disarm() {
      watch = null;
      if (timer !== null) { clearIv(timer); timer = null; }
    }

    function arm(channel) {
      try {
        var v = findVideo();
        watch = {
          channel: channel || '',
          until: now() + rc.watchWindowMs,
          lastTime: v ? v.currentTime : -1,
          lastAdvanceAt: now(),
          step: 0
        };
        if (timer === null) timer = setIv(tick, rc.checkIntervalMs);
      } catch (e) {
        log.warn('recovery arm failed', e && e.message);
      }
    }

    function softKick(v) {
      try {
        v.pause();
        var p = v.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* ignore */ }
    }

    function preserveLocalStorage() {
      var storage, proto, origGet;
      try {
        storage = win.localStorage;
        proto = Object.getPrototypeOf(storage);
        origGet = proto.getItem;
      } catch (e) { return; }
      var keys = rc.preservedLocalStorageKeys;
      var snap = {};
      keys.forEach(function (k) {
        try { snap[k] = origGet.call(storage, k); } catch (e) { /* ignore */ }
      });
      // During the reload window, the player reads our snapshot for these keys.
      var wrapped = function (k) {
        if (this === storage && Object.prototype.hasOwnProperty.call(snap, k) && snap[k] !== null) return snap[k];
        return origGet.apply(this, arguments);
      };
      try { proto.getItem = wrapped; } catch (e) { return; }
      win.setTimeout(function () {
        try { if (proto.getItem === wrapped) proto.getItem = origGet; } catch (e) { /* ignore */ }
        // Write back values the reload may have reset.
        keys.forEach(function (k) {
          try {
            if (snap[k] !== null && snap[k] !== undefined && origGet.call(storage, k) !== snap[k]) storage.setItem(k, snap[k]);
          } catch (e) { /* ignore */ }
        });
      }, rc.preserveWindowMs);
    }

    function hardReload(channel) {
      var ps = null;
      try { ps = finder(); } catch (e) { ps = null; }
      if (!ps || !ps.state) {
        emit('reload-failed', { channel: channel, reason: 'player state not found' });
        return false;
      }
      try {
        if (ps.player && typeof ps.player.isPaused === 'function' && ps.player.isPaused()) return false;
      } catch (e) { /* ignore */ }
      preserveLocalStorage();
      try {
        ps.state.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        if (ps.player && typeof ps.player.play === 'function') ps.player.play();
        emit('player-reload', { channel: channel, count: limiter.count(channel) });
        return true;
      } catch (e) {
        emit('reload-failed', { channel: channel, reason: String(e && e.message) });
        return false;
      }
    }

    function degrade(channel) {
      if (degraded[channel]) return;
      degraded[channel] = true;
      log.warn('too many player reloads on', channel, '- strip-only mode for this page session');
      try { opts.onDegrade(channel); } catch (e) { /* ignore */ }
    }

    function tick() {
      try {
        if (!watch || !isEnabled()) { disarm(); return; }
        var t = now();
        if (t > watch.until) { disarm(); return; }
        var v = findVideo();
        if (!v) return;
        if (v.paused || v.ended) { watch.lastAdvanceAt = t; watch.lastTime = v.currentTime; return; }
        if (v.currentTime !== watch.lastTime) {
          watch.lastTime = v.currentTime;
          watch.lastAdvanceAt = t;
          return;
        }
        if (t - watch.lastAdvanceAt < rc.stallThresholdMs) return;
        // Stalled.
        if (watch.step === 0) {
          watch.step = 1;
          watch.lastAdvanceAt = t;
          log.debug('stall after playlist switch: pause/play');
          softKick(v);
          emit('stall-kick', { channel: watch.channel });
          return;
        }
        if (watch.step === 1) {
          var ch = watch.channel;
          watch.step = 2;
          watch.lastAdvanceAt = t;
          if (degraded[ch]) { disarm(); return; }
          if (limiter.allow(ch)) {
            log.debug('still stalled: player reload');
            hardReload(ch);
          } else {
            degrade(ch);
            disarm();
          }
          return;
        }
        disarm(); // step 2 done: give up for this switch
      } catch (e) {
        log.warn('recovery tick failed', e && e.message);
        disarm();
      }
    }

    function onEvent(name, data) {
      if (!isEnabled()) return;
      if (name === 'playlist-switch' || name === 'ad-end') arm(data && data.channel);
    }

    return {
      onEvent: onEvent,
      arm: arm,
      tick: tick,
      isWatching: function () { return !!watch; },
      isDegraded: function (ch) { return !!degraded[ch]; }
    };
  }

  ns.recovery = {
    createRecovery: createRecovery,
    createReloadLimiter: createReloadLimiter,
    findPlayerAndState: findPlayerAndState
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
