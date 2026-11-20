/*
 * Playback health (src/page/health.js): passive sampling only while the main video plays, and
 * the single gated pause/play nudge of docs/DESIGN-v2.md "The one nudge". Fake video, document
 * and timers; nothing else.
 */
loadSrc('src/config.js', 'src/page/health.js');
var ns = __TAS__;
var cfg = ns.config;
var hc = cfg.health;
var nc = hc.nudge;
var quietLog = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function ranges(list) {
  return { length: list.length, start: function (i) { return list[i][0]; }, end: function (i) { return list[i][1]; } };
}

function makeEnv(o) {
  o = o || {};
  var env = { t: 100000, events: [], pauses: 0, plays: 0, seeks: 0, timers: {}, nextId: 1, listeners: {}, enabled: true };
  var video = {
    nodeName: 'VIDEO', currentSrc: 'blob:https://www.twitch.tv/abc', src: '', paused: false, ended: false,
    readyState: 4, videoHeight: 720,
    pause: function () { env.pauses++; video.paused = true; },
    play: function () { env.plays++; video.paused = false; return Promise.resolve(); },
    getVideoPlaybackQuality: function () { return { droppedVideoFrames: 3, totalVideoFrames: 600 }; }
  };
  var ct = 10;
  Object.defineProperty(video, 'currentTime', {
    get: function () { return ct; },
    set: function (v) { env.seeks++; ct = v; }
  });
  env.bufferAhead = 4; // seconds buffered past the playhead; null = nothing buffered
  Object.defineProperty(video, 'buffered', {
    get: function () { return env.bufferAhead === null ? ranges([]) : ranges([[0, ct + env.bufferAhead]]); }
  });
  env.video = video;
  env.advance = function (sec) { ct += sec; }; // the playhead moves (not a seek)
  env.doc = {
    visibilityState: 'visible',
    querySelectorAll: function () { return env.noVideo ? [] : [video]; },
    addEventListener: function (type, fn) { (env.listeners[type] = env.listeners[type] || []).push(fn); }
  };
  env.fire = function (type, target, extra) {
    var e = { type: type, target: target || video, isTrusted: true };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    (env.listeners[type] || []).forEach(function (fn) { fn(e); });
  };
  var storageTouched = false;
  env.win = {};
  Object.defineProperty(env.win, 'localStorage', { get: function () { storageTouched = true; return null; } });
  env.storageTouched = function () { return storageTouched; };
  env.h = ns.health.createHealth({
    cfg: cfg, log: quietLog, doc: env.doc, win: env.win,
    isEnabled: function () { return env.enabled; },
    emit: function (n, d) { env.events.push({ name: n, data: d }); },
    now: function () { return env.t; },
    setInterval: function (fn, ms) { var id = env.nextId++; env.timers[id] = { fn: fn, ms: ms }; return id; },
    clearInterval: function (id) { delete env.timers[id]; }
  });
  env.timerCount = function () { return Object.keys(env.timers).length; };
  /** Let ms pass in sample steps; the playhead moves only when playing is true. */
  env.run = function (ms, playing) {
    for (var done = 0; done < ms; done += hc.sampleMs) {
      env.t += hc.sampleMs;
      if (playing && !video.paused) env.advance(hc.sampleMs / 1000);
      Object.keys(env.timers).forEach(function (id) { if (env.timers[id]) env.timers[id].fn(); });
    }
  };
  /** One sample after ms (the playhead does not move). */
  env.tick = function (ms) {
    env.t += ms;
    Object.keys(env.timers).forEach(function (id) { if (env.timers[id]) env.timers[id].fn(); });
  };
  env.names = function () { return env.events.map(function (e) { return e.name; }); };
  env.nudges = function () { return env.events.filter(function (e) { return e.name === 'nudge'; }).length; };
  /** Video plays, an ad break starts and the player is switched to another playlist. */
  env.startBreak = function () {
    env.fire('playing');
    env.h.onEvent('ad-detected', { channel: 'c' });
    env.h.onEvent('playlist-switch', { channel: 'c', from: 'native', to: 'backup:popout' });
  };
  return env;
}

test('no timer while nothing plays; the timer runs only while the video plays', function () {
  var env = makeEnv();
  assert.equal(env.timerCount(), 0, 'nothing at start');
  env.video.paused = true;
  env.h.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  assert.equal(env.timerCount(), 0, 'paused video: no timer');
  env.video.paused = false;
  env.fire('playing');
  assert.equal(env.timerCount(), 1, 'playing: one sampling timer');
  assert.equal(env.timers[Object.keys(env.timers)[0]].ms, hc.sampleMs);
  env.fire('playing');
  assert.equal(env.timerCount(), 1, 'never two timers');
  env.video.paused = true;
  env.fire('pause');
  env.run(hc.sampleMs, false);
  assert.equal(env.timerCount(), 0, 'paused: timer stopped');
  env.video.paused = false;
  env.fire('playing');
  env.noVideo = true;
  env.run(hc.sampleMs, false);
  assert.equal(env.timerCount(), 0, 'video gone: timer stopped');
});

test('a video that is not the player (no blob: source) starts nothing', function () {
  var env = makeEnv();
  env.fire('playing', { nodeName: 'VIDEO', currentSrc: 'https://m.media-amazon.com/ad.mp4', paused: false });
  assert.equal(env.timerCount(), 0);
});

test('health event: metrics, at most every reportMs, debug-only data, nothing touched', function () {
  var env = makeEnv();
  env.fire('playing');
  env.fire('waiting');
  env.run(hc.reportMs, true);
  var ev = env.events.filter(function (e) { return e.name === 'health'; });
  assert.equal(ev.length, 1, 'one event per report interval');
  var d = ev[0].data;
  assert.equal(d.waiting, 1);
  assert.equal(d.height, 720);
  assert.equal(d.dropped, 3);
  assert.equal(d.frames, 600);
  assert.ok(Math.abs(d.advanceSec - hc.reportMs / 1000) < 0.01, 'playhead advance ' + d.advanceSec);
  env.run(hc.reportMs - hc.sampleMs, true);
  assert.equal(env.events.filter(function (e) { return e.name === 'health'; }).length, 1, 'not more often');
  assert.equal(env.pauses + env.plays + env.seeks, 0, 'passive');
  assert.notOk(env.storageTouched(), 'no localStorage access');
});

test('stuck after a playlist switch with buffer ahead: exactly one pause/play nudge', function () {
  var env = makeEnv();
  env.startBreak();
  env.run(4000, true);
  assert.equal(env.nudges(), 0, 'playing fine');
  env.run(nc.frozenMs - hc.sampleMs, false);
  assert.equal(env.nudges(), 0, 'not frozen long enough yet');
  env.run(hc.sampleMs * 2, false);
  assert.equal(env.nudges(), 1, 'nudged once');
  assert.equal(env.pauses, 1);
  assert.equal(env.plays, 1);
  assert.equal(env.seeks, 0, 'never seeks');
  assert.equal(env.video.paused, false, 'playing again');
  // Still frozen: no second nudge in this break.
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 1, 'once');
  assert.notOk(env.storageTouched(), 'no localStorage access');
});

test('never while the user paused the video', function () {
  var env = makeEnv();
  env.startBreak();
  env.video.paused = true;
  env.fire('pause');
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 0);
  assert.equal(env.plays, 0);
});

test('never in a hidden tab', function () {
  var env = makeEnv();
  env.doc.visibilityState = 'hidden';
  env.startBreak();
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 0);
  assert.equal(env.pauses, 0);
});

test('never without enough buffered ahead (the player is waiting for data, not wedged)', function () {
  var env = makeEnv();
  env.bufferAhead = nc.minBufferAheadSec / 2;
  env.startBreak();
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 0);
  env.bufferAhead = null;
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 0);
});

test('never outside the window after a switch, nor without any switch', function () {
  var env = makeEnv();
  env.fire('playing');
  env.run(nc.windowAfterSwitchMs, false);
  assert.equal(env.nudges(), 0, 'no switch: nothing');
  var env2 = makeEnv();
  env2.startBreak();
  env2.run(nc.windowAfterSwitchMs, true);
  env2.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env2.nudges(), 0, 'frozen only after the window');
});

test('never right after a user gesture on the player', function () {
  var env = makeEnv();
  env.startBreak();
  env.run(nc.frozenMs - hc.sampleMs, false); // frozen, not long enough yet
  assert.equal(env.nudges(), 0);
  var player = { nodeName: 'DIV', closest: function () { return this; } };
  env.t += 1000;
  env.fire('pointerdown', player);
  env.tick(nc.userGestureWindowMs - 1000);
  assert.equal(env.nudges(), 0, 'gesture within userGestureWindowMs');
  // An untrusted (synthetic) event is not the viewer.
  env.t += 1000;
  env.fire('pointerdown', player, { isTrusted: false });
  env.tick(100);
  assert.equal(env.nudges(), 1, 'after the gesture window, nudged');
});

test('typing in chat is not a gesture on the player', function () {
  var env = makeEnv();
  env.startBreak();
  env.run(nc.frozenMs - hc.sampleMs, false);
  env.t += 1000;
  env.fire('keydown', { nodeName: 'TEXTAREA', closest: function () { return null; } });
  env.tick(1000);
  assert.equal(env.nudges(), 1);
});

test('at most once per ad break, even with several switches; again in the next break after minIntervalMs', function () {
  var env = makeEnv();
  env.startBreak();
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.nudges(), 1);
  env.h.onEvent('playlist-switch', { channel: 'c', from: 'backup:popout', to: 'stripped' });
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  env.h.onEvent('ad-end', { channel: 'c', outcome: 'backup' });
  env.h.onEvent('playlist-switch', { channel: 'c', from: 'stripped', to: 'native' });
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.nudges(), 1, 'same break: once');
  // A new break soon after: still within minIntervalMs of the last nudge.
  env.h.onEvent('ad-detected', { channel: 'c' });
  env.h.onEvent('playlist-switch', { channel: 'c', from: 'native', to: 'backup:popout' });
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.nudges(), 1, 'within minIntervalMs: no');
  env.run(nc.minIntervalMs, true);
  env.h.onEvent('ad-detected', { channel: 'c' });
  env.h.onEvent('playlist-switch', { channel: 'c', from: 'native', to: 'backup:popout' });
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.nudges(), 2, 'next break, after minIntervalMs: once more');
});

test('extension switched off: events ignored, the running timer stops, nothing touched', function () {
  var env = makeEnv();
  env.startBreak();
  env.enabled = false;
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.timerCount(), 0);
  assert.equal(env.nudges(), 0);
  env.fire('playing');
  env.h.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  assert.equal(env.timerCount(), 0);
});

test('play() rejected after the nudge: no retry, no exception', function () {
  var env = makeEnv();
  env.video.play = function () { env.plays++; return Promise.reject({ name: 'NotAllowedError' }); };
  env.startBreak();
  env.run(nc.frozenMs + 2 * hc.sampleMs, false);
  assert.equal(env.nudges(), 1);
  return Promise.resolve().then(function () {
    assert.equal(env.plays, 1, 'no muted retry');
    assert.equal(env.video.muted, undefined, 'mute untouched');
  });
});
