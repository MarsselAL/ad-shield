/*
 * Player recovery / health (MAIN world). docs/research-technique.md §5 and
 * docs/research-2026-11-13.md §1 C5, §2 (F2, F6, F7, F9) / §4 items 2, 4, 5.
 *
 * A watch is armed after every playlist switch (native <-> backup <-> stripped), every ad end
 * (for at least frozenPictureWatchMs), and (while a backup/stripped playlist is served, and for
 * rearmAfterNativeMs after returning to native) on the main <video>'s waiting/stalled events
 * and on pauses nobody asked for.
 * While armed, once per checkIntervalMs, and only while the tab is visible:
 *   - paused, and the pause did not follow a click/key on the player  -> play()
 *   - playhead stuck stallThresholdMs (3 ticks), not enough data (readyState < 3) and a hole
 *     in the buffered ranges ahead                                     -> seek over the hole
 *   - playhead stuck and less than drainingBufferSec buffered ahead   -> pause/play nudge
 *   - picture frozen while the sound plays: playhead advancing but the decoded-frame counter
 *     (getVideoPlaybackQuality / webkitDecodedFrameCount) flat, or videoWidth 0, for
 *     frozenPictureTicks samples in a row (not when the viewer chose audio-only; no counter: not
 *     checked)                                                         -> pause/play nudge
 *   at most maxSoftKicks per watch, minKickIntervalMs apart, maxKicksPerWindow overall;
 *   - still stuck hardReloadAfterMs after the first soft action       -> one hard player reload
 *     (React fiber setSrc, localStorage quality/volume/muted/lowLatency kept), not within
 *     reloadCooldownMs of the previous one, and not for a watch armed only by a break that
 *     stripped nothing / used a backup of the native quality (soft recovery only) unless the
 *     picture is frozen ('frozen-picture' may always reload);
 *   - then the watch ends with giveUpCooldownMs of no automatic actions (no loops).
 * play() rejected with NotAllowedError (no sound allowed): retried once muted, and the sound is
 * restored at the next click/key unless someone unmuted or the viewer had muted already.
 * 'segment-repeat' from the worker (the player was handed a segment it already had): one
 * pause/play, at most once per repeatRestartMinIntervalMs.
 * Hard reloads are rate-limited per channel (maxReloadsPerWindow per reloadWindowMs). Over the
 * limit, the channel is switched to strip-only mode for the page session (onDegrade).
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
    var lastGestureAt = -Infinity;
    var ownPauseAt = -Infinity;
    var pauses = typeof WeakMap === 'function' ? new WeakMap() : null; // video -> { user }
    var serving = 'native';
    var nativeSince = -Infinity;
    var lastChannel = '';
    var kickTimes = [];
    var cooldownUntil = -Infinity;
    var lastReloadAt = -Infinity;
    var lastRepeatKickAt = -Infinity;
    var mutedByUs = null; // { video, volume }: we muted to get play() allowed

    function isMainVideo(v) {
      return !!v && v.nodeName === 'VIDEO' && String(v.currentSrc || v.src || '').indexOf('blob:') === 0;
    }

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

    function visible() {
      return !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
    }

    /** A pause counts as the viewer's when it follows a click/key on the player (or is unknown). */
    function userPaused(v) {
      if (!v || !v.paused) return false;
      var info = pauses ? pauses.get(v) : null;
      return !info || info.user;
    }

    /** Waiting/stalled/unexpected pauses matter while a backup/stripped playlist is served and a bit after. */
    function sensitive() {
      return serving !== 'native' || now() - nativeSince < rc.rearmAfterNativeMs;
    }

    function onPlayer(e) {
      var t = e && e.target;
      if (e.type === 'keydown') {
        if (!t) return true;
        var tag = String(t.nodeName || '').toUpperCase();
        return !(tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable); // typing in chat is not a player key
      }
      if (t && typeof t.closest === 'function') {
        try { return !!t.closest(cfg.player.playerContainerSelector + ',video'); } catch (err) { return true; }
      }
      return true;
    }

    function restoreSound() {
      if (!mutedByUs) return;
      var m = mutedByUs;
      mutedByUs = null;
      try {
        if (m.video.muted) {
          m.video.muted = false;
          if (typeof m.volume === 'number') m.video.volume = m.volume;
        }
      } catch (e) { /* ignore */ }
    }

    function onGesture(e) {
      try {
        if (!isEnabled() || (e && e.isTrusted === false)) return;
        restoreSound(); // any real gesture allows sound again
        if (onPlayer(e)) lastGestureAt = now();
      } catch (err) { /* ignore */ }
    }

    function onMediaEvent(e) {
      try {
        var v = e && e.target;
        if (!isEnabled() || !isMainVideo(v)) return;
        var t = now();
        if (e.type === 'pause') {
          var own = t - ownPauseAt < 1000;
          var user = !own && t - lastGestureAt <= rc.userGestureWindowMs;
          if (pauses) pauses.set(v, { user: user });
          if (!user && !own && sensitive()) arm(lastChannel, { hard: true });
        } else if (e.type === 'play' || e.type === 'playing') {
          if (pauses) pauses.delete(v);
        } else if (e.type === 'waiting' || e.type === 'stalled') {
          if (sensitive()) arm(lastChannel, { hard: true });
        } else if (e.type === 'volumechange') {
          if (mutedByUs && mutedByUs.video === v && !v.muted) mutedByUs = null; // unmuted by someone: done
        }
      } catch (err) { /* ignore */ }
    }

    if (doc && typeof doc.addEventListener === 'function') {
      ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (type) {
        doc.addEventListener(type, onGesture, true);
      });
      // Media events do not bubble, but a capturing listener on the document sees them.
      ['pause', 'play', 'playing', 'waiting', 'stalled', 'volumechange'].forEach(function (type) {
        doc.addEventListener(type, onMediaEvent, true);
      });
    }

    function disarm() {
      watch = null;
      if (timer !== null) { clearIv(timer); timer = null; }
    }

    /** Start a watch, or extend the running one (its counters are kept: no reset by re-arming). */
    function arm(channel, o) {
      try {
        var t = now();
        if (t < cooldownUntil) return;
        var hard = !o || o.hard !== false;
        var span = Math.max(rc.watchWindowMs, (o && o.minMs) || 0);
        if (watch) {
          watch.until = Math.max(watch.until, t + span);
          if (hard) watch.hard = true;
          if (channel) watch.channel = channel;
          return;
        }
        var v = findVideo();
        watch = {
          channel: channel || lastChannel || '',
          until: t + span,
          lastTime: v ? v.currentTime : -1,
          lastFrames: v ? decodedFrames(v) : null,
          frozenTicks: 0,
          lastAdvanceAt: t,
          healthySince: t,
          stallSince: null,
          firstSoftAt: null,
          kicks: 0,
          lastKickAt: -Infinity,
          reloaded: false,
          hard: hard
        };
        if (timer === null) timer = setIv(tick, rc.checkIntervalMs);
      } catch (e) {
        log.warn('recovery arm failed', e && e.message);
      }
    }

    /** Decoded video frames so far, or null when the browser exposes no counter. */
    function decodedFrames(v) {
      try {
        if (typeof v.getVideoPlaybackQuality === 'function') {
          var q = v.getVideoPlaybackQuality();
          if (q && typeof q.totalVideoFrames === 'number') return q.totalVideoFrames;
        }
        if (typeof v.webkitDecodedFrameCount === 'number') return v.webkitDecodedFrameCount;
      } catch (e) { /* ignore */ }
      return null;
    }

    /** The viewer picked "Audio Only" (Twitch stores {"default":"audio_only"} in video-quality). */
    function audioOnly() {
      try {
        var raw = win.localStorage.getItem('video-quality');
        var q = raw ? JSON.parse(raw) : null;
        return q === 'audio_only' || !!(q && q['default'] === 'audio_only');
      } catch (e) { return false; }
    }

    /**
     * One sample on a tick where the playhead advanced: true when it advanced at least
     * frozenPictureMinAdvanceSec while (almost) no frames were decoded, or there is no picture
     * at all (videoWidth 0). No frame counter: never true (research-2026-11-13 C5/F7).
     */
    function frozenPictureSample(v) {
      var frames = decodedFrames(v);
      var prev = watch.lastFrames;
      watch.lastFrames = frames;
      if (frames === null || prev === null || prev === undefined) return false;
      if (v.currentTime - watch.lastTime < rc.frozenPictureMinAdvanceSec) return false;
      if (frames < prev) return false; // counter restarted (new media source)
      if (frames - prev >= rc.frozenPictureMinFrames && v.videoWidth !== 0) return false;
      return !audioOnly();
    }

    function kicksAllowed(t) {
      kickTimes = kickTimes.filter(function (x) { return t - x < rc.kickWindowMs; });
      return kickTimes.length < rc.maxKicksPerWindow;
    }

    /** play() that copes with a rejection: NotAllowedError -> one muted retry (sound restored later). */
    function safePlay(v) {
      var p;
      try { p = v.play(); } catch (e) { return; }
      if (!p || typeof p.then !== 'function') return;
      p.then(null, function (err) {
        try {
          if (!isEnabled() || !err || err.name !== 'NotAllowedError') return;
          if (v.muted || mutedByUs) return; // muted already (maybe by the viewer): nothing more to try
          mutedByUs = { video: v, volume: v.volume };
          v.muted = true;
          emit('stall-kick', { channel: lastChannel, action: 'muted-play' });
          var p2 = v.play();
          if (p2 && typeof p2.then === 'function') p2.then(null, function () { restoreSound(); });
        } catch (e) { /* ignore */ }
      });
    }

    function ahead(v) {
      var b = v.buffered;
      var ct = v.currentTime;
      if (!b || !b.length) return 0;
      for (var i = 0; i < b.length; i++) {
        if (ct >= b.start(i) - rc.gapToleranceSec && ct < b.end(i)) return b.end(i) - ct;
      }
      return 0;
    }

    /** Where to seek to get over a hole in the buffered ranges, or null if there is none. */
    function gapTarget(v) {
      var b = v.buffered;
      if (!b || !b.length) return null;
      var ct = v.currentTime;
      var tol = rc.gapToleranceSec;
      for (var i = 0; i < b.length; i++) {
        var s = b.start(i), e = b.end(i);
        if (ct >= s - tol && ct < e - tol) return null; // data right here: no hole to skip
        if (s > ct) return s + rc.gapSeekOffsetSec;     // first range ahead of the playhead
      }
      var lastEnd = b.end(b.length - 1);
      // Playhead beyond everything buffered (timestamps went back after a switch): go back to the data.
      if (ct > lastEnd + 1) return Math.max(b.start(b.length - 1), lastEnd - 1.5);
      return null;
    }

    /** One soft action; returns its name. */
    function softKick(v, reason) {
      var action;
      if (v.paused) {
        action = 'play';
        safePlay(v);
      } else {
        var target = reason === 'stall' && (v.readyState === undefined || v.readyState < 3) ? gapTarget(v) : null;
        if (target !== null) {
          action = 'seek';
          try { v.currentTime = target; } catch (e) { /* ignore */ }
        } else {
          action = 'nudge';
          ownPauseAt = now();
          try { v.pause(); } catch (e) { /* ignore */ }
          safePlay(v);
        }
      }
      return action;
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

    function hardReload(channel, v) {
      var ps = null;
      try { ps = finder(); } catch (e) { ps = null; }
      if (!ps || !ps.state) {
        emit('reload-failed', { channel: channel, reason: 'player state not found' });
        return false;
      }
      // Only the viewer's own pause stops a reload (the player pausing itself is what we fix).
      if (userPaused(v)) return false;
      preserveLocalStorage();
      try {
        ps.state.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        if (ps.player && typeof ps.player.play === 'function') ps.player.play();
        lastReloadAt = now();
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

    function giveUp(t) {
      cooldownUntil = t + rc.giveUpCooldownMs;
      disarm();
    }

    function tick() {
      try {
        if (!watch || !isEnabled()) { disarm(); return; }
        var t = now();
        if (t > watch.until) { disarm(); return; }
        var v = findVideo();
        if (!v) return;
        // Hidden tab: browsers stop drawing video; never act then (research-2026-11-13 C5).
        if (!visible() || v.ended || userPaused(v)) {
          watch.lastAdvanceAt = t; watch.lastTime = v.currentTime; watch.stallSince = null;
          watch.lastFrames = decodedFrames(v); watch.frozenTicks = 0;
          return;
        }
        var reason;
        if (!v.paused && Math.abs(v.currentTime - watch.lastTime) > 0.1) {
          var frozen = frozenPictureSample(v);
          watch.lastTime = v.currentTime;
          watch.lastAdvanceAt = t;
          if (!frozen) {
            watch.frozenTicks = 0;
            watch.stallSince = null;
            if (t - watch.healthySince >= rc.healthyResetMs) { watch.kicks = 0; watch.firstSoftAt = null; }
            return;
          }
          // Sound plays, the picture does not: no healthy reset while this lasts.
          watch.healthySince = t;
          if (++watch.frozenTicks < rc.frozenPictureTicks) return;
          watch.until = Math.max(watch.until, t + 2 * rc.checkIntervalMs);
          reason = 'frozen-picture';
          if (watch.stallSince === null) watch.stallSince = t;
        } else {
          watch.lastFrames = decodedFrames(v);
          watch.frozenTicks = 0;
          watch.healthySince = t;
          // Keep watching while frozen; the ladder below always ends in giveUp, so this is bounded.
          watch.until = Math.max(watch.until, t + 2 * rc.checkIntervalMs);
          reason = v.paused ? 'paused' : 'stall';
          if (t - watch.lastAdvanceAt < (v.paused ? rc.pausedStallMs : rc.stallThresholdMs)) return;
          if (watch.stallSince === null) watch.stallSince = t;
        }
        // A frozen picture is broken whatever armed the watch: it may always end in a reload.
        var mayReload = watch.hard || reason === 'frozen-picture';
        // Stalled: soft actions first.
        if (watch.kicks < rc.maxSoftKicks && kicksAllowed(t)) {
          if (t - watch.lastKickAt < rc.minKickIntervalMs) return;
          var draining = ahead(v) < rc.drainingBufferSec;
          var gap = reason === 'stall' && (v.readyState === undefined || v.readyState < 3) && gapTarget(v) !== null;
          if (reason === 'paused' || reason === 'frozen-picture' || draining || gap) {
            watch.kicks++;
            watch.lastKickAt = t;
            if (watch.firstSoftAt === null) watch.firstSoftAt = t;
            kickTimes.push(t);
            var action = softKick(v, reason); // 'frozen-picture': never paused here, so a pause/play nudge
            if (reason === 'frozen-picture') action = reason;
            log.debug('stall after playlist switch:', action);
            emit('stall-kick', { channel: watch.channel, action: action });
            return;
          }
        }
        // Soft actions used up (or none fits): the hard reload, if this watch may do one.
        var since = watch.firstSoftAt !== null ? watch.firstSoftAt : watch.stallSince;
        if (!watch.reloaded && mayReload && t - since >= rc.hardReloadAfterMs) {
          if (t - lastReloadAt < rc.reloadCooldownMs) return;
          var ch = watch.channel;
          watch.reloaded = true;
          watch.lastAdvanceAt = t;
          watch.stallSince = null;
          watch.frozenTicks = 0;
          if (degraded[ch]) { giveUp(t); return; }
          if (limiter.allow(ch)) {
            log.debug('still stalled: player reload');
            hardReload(ch, v);
          } else {
            degrade(ch);
            giveUp(t);
          }
          return;
        }
        if (watch.reloaded || !mayReload) {
          // Nothing left to try for this watch.
          if (t - since >= rc.hardReloadAfterMs) giveUp(t);
        }
      } catch (e) {
        log.warn('recovery tick failed', e && e.message);
        disarm();
      }
    }

    /** 'segment-repeat': the player was handed a segment it already had; restart it once. */
    function repeatKick() {
      var t = now();
      if (t - lastRepeatKickAt < rc.repeatRestartMinIntervalMs || !visible()) return;
      var v = findVideo();
      if (!v || v.paused || v.ended) return;
      lastRepeatKickAt = t;
      ownPauseAt = t;
      try { v.pause(); } catch (e) { /* ignore */ }
      safePlay(v);
      emit('stall-kick', { channel: lastChannel, action: 'repeat-restart' });
    }

    function onEvent(name, data) {
      try {
        if (!isEnabled()) return;
        var d = data || {};
        if (d.channel) lastChannel = d.channel;
        if (name === 'playlist-switch') {
          serving = d.to || 'native';
          if (serving === 'native') nativeSince = now();
          // Switching to the stripped playlist or to a backup of another quality may need a reload;
          // the switch back to native is judged by the ad-end that comes with it.
          arm(d.channel, { hard: serving === 'stripped' || (serving !== 'native' && d.matched === false) });
        } else if (name === 'ad-end') {
          // Prefer soft recovery when nothing was stripped or the backup matched native quality.
          // Watch longer than usual: the frozen-picture wedge shows up right after breaks.
          var soft = d.outcome === 'none' || (d.outcome === 'backup' && d.matched);
          arm(d.channel, { hard: !soft, minMs: rc.frozenPictureWatchMs });
        } else if (name === 'segment-repeat') {
          repeatKick();
        }
      } catch (e) {
        log.warn('recovery event failed', e && e.message);
      }
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
