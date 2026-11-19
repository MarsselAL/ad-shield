/*
 * Playback health (MAIN world). docs/DESIGN-v2.md "Metrics (health.js)" and "The one nudge".
 * Replaces 1.x recovery.js: no seeks, no reloads, no localStorage, no muted retries.
 *
 * Metrics: while the main Twitch <video> (MSE, blob: source) plays, one sample every
 * cfg.health.sampleMs: playhead advance, 'waiting' events, getVideoPlaybackQuality()
 * dropped/total frames, videoHeight, time paused. Summed into a 'health' event at most once per
 * cfg.health.reportMs (page.js forwards it only with debug on). No timer while nothing plays.
 *
 * The one nudge (vaft #476/#492: after a playlist switch the player sometimes wedges; one
 * pause/play clears it, repeated or early kicks make it worse): within windowAfterSwitchMs of a
 * 'playlist-switch' event, tab visible, video not paused or ended, playhead not advanced for
 * frozenMs with at least minBufferAheadSec buffered ahead, and no click/key on the player in the
 * last userGestureWindowMs -> pause() then play(). At most once per ad break (a break starts with
 * 'ad-detected') and once per minIntervalMs.
 *
 * opts.isEnabled() false (extension switched off): events are ignored and a running timer stops
 * on its next sample. Every step is wrapped in try/catch.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) throw new Error('[TAS] health.js needs config.js first');

  /**
   * @param opts { cfg, log, doc, win, isEnabled, emit(name, data),
   *               now?, setInterval?, clearInterval? (tests) }
   */
  function createHealth(opts) {
    var cfg = opts.cfg;
    var hc = cfg.health;
    var nc = hc.nudge;
    var log = opts.log;
    var doc = opts.doc;
    var now = opts.now || function () { return Date.now(); };
    var setIv = opts.setInterval || function (f, ms) { return setInterval(f, ms); };
    var clearIv = opts.clearInterval || function (id) { clearInterval(id); };
    var emit = opts.emit || function () {};
    var isEnabled = opts.isEnabled || function () { return true; };

    var timer = null;
    var channel = '';
    var lastGestureAt = -Infinity;
    var lastSwitchAt = -Infinity;
    var lastNudgeAt = -Infinity;
    var breakNudged = false;
    var pausedAt = null;           // main video paused since (ms), or null
    var last = null;               // previous sample: { time, at }
    var lastAdvanceAt = 0;
    var win = null;                // metrics since the last report

    function newWindow(t) {
      win = { since: t, advanceSec: 0, waiting: 0, pausedMs: 0, nudges: 0 };
    }
    newWindow(now());

    function isMainVideo(v) {
      return !!v && v.nodeName === 'VIDEO' && String(v.currentSrc || v.src || '').indexOf('blob:') === 0;
    }

    function findVideo() {
      var vids = doc.querySelectorAll(cfg.player.videoSelector);
      for (var i = 0; i < vids.length; i++) if (isMainVideo(vids[i])) return vids[i];
      return null;
    }

    function visible() {
      return !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
    }

    function playing(v) {
      return !!v && !v.paused && !v.ended;
    }

    /** A click/key aimed at the player (typing in chat is not). */
    function onPlayer(e) {
      var t = e && e.target;
      if (e.type === 'keydown') {
        if (!t) return true;
        var tag = String(t.nodeName || '').toUpperCase();
        return !(tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable);
      }
      if (t && typeof t.closest === 'function') {
        try { return !!t.closest(cfg.player.playerContainerSelector + ',video'); } catch (err) { return true; }
      }
      return true;
    }

    function onGesture(e) {
      try {
        if (!isEnabled() || (e && e.isTrusted === false)) return;
        if (onPlayer(e)) lastGestureAt = now();
      } catch (err) { /* ignore */ }
    }

    function start(v) {
      if (timer !== null) return;
      var t = now();
      last = { time: v.currentTime, at: t };
      lastAdvanceAt = t;
      timer = setIv(sample, hc.sampleMs);
    }

    function stop() {
      if (timer !== null) { clearIv(timer); timer = null; }
      last = null;
    }

    function onMediaEvent(e) {
      try {
        var v = e && e.target;
        if (!isEnabled() || !isMainVideo(v)) return;
        var t = now();
        if (e.type === 'play' || e.type === 'playing') {
          if (pausedAt !== null) { win.pausedMs += t - pausedAt; pausedAt = null; }
          if (playing(v)) start(v);
        } else if (e.type === 'pause') {
          if (pausedAt === null) pausedAt = t;
        } else if (e.type === 'waiting') {
          win.waiting++;
        }
      } catch (err) { /* ignore */ }
    }

    if (doc && typeof doc.addEventListener === 'function') {
      ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (type) {
        doc.addEventListener(type, onGesture, true);
      });
      // Media events do not bubble, but a capturing listener on the document sees them.
      ['play', 'playing', 'pause', 'waiting'].forEach(function (type) {
        doc.addEventListener(type, onMediaEvent, true);
      });
    }

    function bufferedAhead(v) {
      var b = v.buffered;
      var ct = v.currentTime;
      if (!b || !b.length) return 0;
      for (var i = 0; i < b.length; i++) {
        if (ct >= b.start(i) - 0.1 && ct < b.end(i)) return b.end(i) - ct;
      }
      return 0;
    }

    function quality(v) {
      try {
        if (typeof v.getVideoPlaybackQuality === 'function') {
          var q = v.getVideoPlaybackQuality();
          if (q) return { dropped: q.droppedVideoFrames || 0, frames: q.totalVideoFrames || 0 };
        }
      } catch (e) { /* ignore */ }
      return { dropped: null, frames: null };
    }

    function report(v, t) {
      if (t - win.since < hc.reportMs) return;
      var q = quality(v);
      var d = {
        channel: channel,
        periodMs: t - win.since,
        advanceSec: Math.round(win.advanceSec * 100) / 100,
        waiting: win.waiting,
        pausedMs: win.pausedMs + (pausedAt !== null ? t - pausedAt : 0),
        dropped: q.dropped,
        frames: q.frames,
        height: v.videoHeight || 0,
        nudges: win.nudges
      };
      log.debug('health', d);
      emit('health', d);
      newWindow(t);
      if (pausedAt !== null) pausedAt = t;
    }

    /** The one nudge: pause() then play(), only when every condition of the rule holds. */
    function maybeNudge(v, t) {
      if (breakNudged || t - lastNudgeAt < nc.minIntervalMs) return;
      if (t - lastSwitchAt > nc.windowAfterSwitchMs) return;
      if (!visible() || !playing(v)) return;
      if (t - lastAdvanceAt < nc.frozenMs) return;
      if (bufferedAhead(v) < nc.minBufferAheadSec) return;
      if (t - lastGestureAt <= nc.userGestureWindowMs) return;
      breakNudged = true;
      lastNudgeAt = t;
      lastAdvanceAt = t;
      win.nudges++;
      log.debug('playhead frozen after a playlist switch: one pause/play');
      try { v.pause(); } catch (e) { /* ignore */ }
      try {
        var p = v.play();
        if (p && typeof p.then === 'function') p.then(null, function () { /* not retried */ });
      } catch (e) { /* ignore */ }
      emit('nudge', { channel: channel });
    }

    function sample() {
      try {
        if (!isEnabled()) { stop(); return; }
        var v = findVideo();
        if (!playing(v)) { stop(); return; }
        var t = now();
        var adv = last ? v.currentTime - last.time : 0;
        if (adv > 0.05) {
          win.advanceSec += adv;
          lastAdvanceAt = t;
        } else if (adv < 0 || !last) {
          lastAdvanceAt = t; // new media or a seek by the player: not frozen
        }
        last = { time: v.currentTime, at: t };
        maybeNudge(v, t);
        report(v, t);
      } catch (e) {
        log.warn('health sample failed', e && e.message);
        stop();
      }
    }

    function onEvent(name, data) {
      try {
        if (!isEnabled()) return;
        var d = data || {};
        if (d.channel) channel = d.channel;
        if (name === 'ad-detected') {
          breakNudged = false;
        } else if (name === 'playlist-switch') {
          lastSwitchAt = now();
          var v = findVideo();
          if (playing(v)) start(v);
        }
      } catch (e) {
        log.warn('health event failed', e && e.message);
      }
    }

    return {
      onEvent: onEvent,
      sample: sample,
      isSampling: function () { return timer !== null; }
    };
  }

  ns.health = { createHealth: createHealth };
})(typeof globalThis !== 'undefined' ? globalThis : this);
