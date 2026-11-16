/*
 * Recovery: watch after a playlist switch, user-intent tracking, play() rejection, buffer-gap
 * seek, soft actions before a rate-limited hard reload, cooldown, degrade, repeat restart,
 * frozen picture with sound (decoded-frame counter flat or videoWidth 0).
 */
loadSrc('src/config.js', 'src/shared/logger.js', 'src/page/recovery.js');
var ns = __TAS__;
var cfg = ns.config;
var rc = cfg.recovery;
var quietLog = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function ranges(list) {
  return { length: list.length, start: function (i) { return list[i][0]; }, end: function (i) { return list[i][1]; } };
}

function makeEnv(isEnabled, o) {
  o = o || {};
  var env = { t: 0, events: [], eventData: [], degraded: [], reloads: 0, kicks: 0, plays: 0, intervals: 0, cleared: 0, listeners: {} };
  env.playResult = function () { return Promise.resolve(); };
  env.video = {
    nodeName: 'VIDEO', currentSrc: 'blob:https://www.twitch.tv/abc', src: '', currentTime: 10, paused: false, ended: false,
    muted: false, volume: 0.7, readyState: 4, buffered: ranges([]),
    pause: function () { env.kicks++; }, play: function () { env.plays++; return env.playResult(); }
  };
  env.doc = {
    visibilityState: 'visible',
    querySelectorAll: function () { return [env.video]; }, querySelector: function () { return null; },
    addEventListener: function (type, fn) { (env.listeners[type] = env.listeners[type] || []).push(fn); }
  };
  env.fire = function (type, target) {
    (env.listeners[type] || []).forEach(function (fn) { fn({ type: type, target: target || env.video }); });
  };
  env.state = { setSrc: function (x) { env.reloads++; env.lastSetSrc = x; }, setInitialPlaybackSettings: function () {} };
  env.player = { play: function () {}, isPaused: function () { return true; } }; // the player's own flag is not trusted
  env.store = o.store || null; // { key: value } for win.localStorage
  var localStorage = env.store ? { getItem: function (k) { return Object.prototype.hasOwnProperty.call(env.store, k) ? env.store[k] : null; } } : null;
  env.rec = ns.recovery.createRecovery({
    cfg: cfg, log: quietLog, doc: env.doc,
    win: { localStorage: localStorage, setTimeout: function () {} },
    now: function () { return env.t; },
    setInterval: function () { env.intervals++; return 1; },
    clearInterval: function () { env.cleared++; },
    emit: function (n, d) { env.events.push(n); env.eventData.push(d); },
    onDegrade: function (ch) { env.degraded.push(ch); },
    findPlayerAndState: o.finder || function () { return { player: env.player, state: env.state }; },
    isEnabled: isEnabled
  });
  env.step = function (ms) { env.t += ms; env.rec.tick(); };
  env.run = function (ms) { for (var i = 0; i < ms; i += 1000) env.step(1000); };
  env.actions = function () {
    return env.eventData.filter(function (d, i) { return env.events[i] === 'stall-kick'; }).map(function (d) { return d.action; });
  };
  return env;
}

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) p = p.then(function () {});
  return p;
}

/** Arm a stripped switch and keep the video frozen until a reload happens, then let the cooldown pass. */
function stallThroughReload(env, ch) {
  env.rec.onEvent('playlist-switch', { channel: ch, to: 'stripped' });
  var before = env.reloads;
  for (var i = 0; i < 40 && env.reloads === before && env.rec.isWatching(); i++) env.step(1000);
  env.run(5000);
  env.t += rc.giveUpCooldownMs + rc.reloadCooldownMs + 1;
}

test('no timer until a playlist switch arms the watch', function () {
  var env = makeEnv();
  assert.equal(env.intervals, 0);
  env.rec.onEvent('ad-detected', { channel: 'c' });
  assert.equal(env.intervals, 0);
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  assert.equal(env.intervals, 1);
  assert.ok(env.rec.isWatching());
});

test('advancing video: nothing happens and the watch ends after the window', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  for (var i = 0; i < 10; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.equal(env.kicks, 0);
  env.video.currentTime += 1;
  env.step(rc.watchWindowMs);
  assert.notOk(env.rec.isWatching());
  assert.equal(env.cleared, 1);
});

test('paused with no known cause (e.g. autoplay never started) is left alone', function () {
  var env = makeEnv();
  env.video.paused = true;
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.run(30000);
  assert.equal(env.plays, 0);
  assert.equal(env.reloads, 0);
});

test('paused after a switch, not by the user: play() after pausedStallMs', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'backup:popout', matched: true });
  env.video.paused = true;
  env.fire('pause');
  env.step(1000);
  assert.equal(env.plays, 0, 'not yet');
  env.step(rc.pausedStallMs);
  assert.equal(env.plays, 1, 'resumed');
  assert.deepEqual(env.actions(), ['play']);
});

test('an unexpected pause while a backup is served arms the watch by itself', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'backup:popout', matched: true });
  env.run(rc.watchWindowMs + 1000); // video "advances"? no: frozen but healthy check below
  env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'backup:popout', matched: true });
  for (var i = 0; i < 25; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.notOk(env.rec.isWatching(), 'watch over');
  env.video.paused = true;
  env.fire('pause');
  assert.ok(env.rec.isWatching(), 're-armed by the pause');
  env.run(rc.pausedStallMs + 1000);
  assert.equal(env.plays, 1);
});

test('pause right after a click on the player is the viewer\'s: never resumed, never reloaded', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.fire('pointerdown');
  env.t += 200;
  env.video.paused = true;
  env.fire('pause');
  env.run(40000);
  assert.equal(env.plays, 0);
  assert.equal(env.reloads, 0);
  // Pressing play again clears it.
  env.video.paused = false;
  env.fire('play');
});

test('a click long before the pause does not make it the viewer\'s', function () {
  var env = makeEnv();
  env.fire('pointerdown');
  env.t += rc.userGestureWindowMs + 1000;
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.video.paused = true;
  env.fire('pause');
  env.run(rc.pausedStallMs + 1000);
  assert.equal(env.plays, 1);
});

test('play() rejected (no sound allowed): retried once muted, sound restored at the next click', function () {
  var env = makeEnv();
  var n = 0;
  env.playResult = function () { n++; return n === 1 ? Promise.reject({ name: 'NotAllowedError' }) : Promise.resolve(); };
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.video.paused = true;
  env.fire('pause');
  env.run(rc.pausedStallMs + 1000);
  return flush().then(function () {
    assert.equal(env.plays, 2, 'muted retry');
    assert.equal(env.video.muted, true);
    assert.ok(env.actions().indexOf('muted-play') !== -1);
    env.video.volume = 0.7;
    env.fire('pointerdown', {});
    assert.equal(env.video.muted, false, 'sound back after a gesture');
    assert.equal(env.video.volume, 0.7);
  });
});

test('play() rejected while the viewer had muted: no muted retry, mute left as it was', function () {
  var env = makeEnv();
  env.video.muted = true;
  env.playResult = function () { return Promise.reject({ name: 'NotAllowedError' }); };
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.video.paused = true;
  env.fire('pause');
  env.run(rc.pausedStallMs + 1000);
  return flush().then(function () {
    assert.equal(env.plays, 1);
    env.fire('pointerdown', {});
    assert.equal(env.video.muted, true, 'still muted: the viewer\'s choice');
  });
});

test('someone unmutes after our muted retry: we do not touch the sound any more', function () {
  var env = makeEnv();
  var n = 0;
  env.playResult = function () { n++; return n === 1 ? Promise.reject({ name: 'NotAllowedError' }) : Promise.resolve(); };
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.video.paused = true;
  env.fire('pause');
  env.run(rc.pausedStallMs + 1000);
  return flush().then(function () {
    env.video.muted = false;
    env.video.volume = 0.2;
    env.fire('volumechange');
    env.video.muted = true; // the viewer mutes again later
    env.fire('pointerdown', {});
    assert.equal(env.video.muted, true);
    assert.equal(env.video.volume, 0.2);
  });
});

test('frozen at a hole in the buffer (readyState < 3): seek to the next buffered range', function () {
  var env = makeEnv();
  env.video.readyState = 2;
  env.video.buffered = ranges([[0, 10], [12, 20]]);
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.step(1000);
  env.step(1000);
  assert.equal(env.video.currentTime, 10, 'not before 3 ticks');
  env.step(1000);
  assert.equal(env.video.currentTime, 12 + rc.gapSeekOffsetSec);
  assert.deepEqual(env.actions(), ['seek']);
  assert.equal(env.kicks, 0, 'no pause/play for a seek');
});

test('frozen with plenty buffered ahead and no hole: no pause/play nudge (it self-triggers)', function () {
  var env = makeEnv();
  env.video.buffered = ranges([[0, 20]]);
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.run(10000);
  assert.equal(env.kicks, 0);
});

test('stall: nudges at least minKickIntervalMs apart, hard reload after hardReloadAfterMs, then give up with a cooldown', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.run(rc.stallThresholdMs);
  assert.equal(env.kicks, 1, 'first nudge (frozen, buffer draining)');
  env.run(rc.minKickIntervalMs - 1000);
  assert.equal(env.kicks, 1, 'rate limited');
  env.run(1000);
  assert.equal(env.kicks, 2, 'second nudge');
  // first nudge at stallThresholdMs; reload is due hardReloadAfterMs after it
  var due = rc.stallThresholdMs + rc.hardReloadAfterMs;
  while (env.t < due - 1000) env.step(1000);
  assert.equal(env.kicks, 2, 'at most maxSoftKicks per watch');
  assert.equal(env.reloads, 0, 'not before hardReloadAfterMs');
  env.step(1000);
  assert.equal(env.reloads, 1, 'hard reload (the player\'s own isPaused() does not stop it)');
  assert.deepEqual(env.lastSetSrc, { isNewMediaPlayerInstance: true, refreshAccessToken: true });
  env.run(rc.stallThresholdMs + 2000);
  assert.notOk(env.rec.isWatching(), 'gave up');
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'native' });
  assert.notOk(env.rec.isWatching(), 'cooldown: not re-armed');
  env.t += rc.giveUpCooldownMs;
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  assert.ok(env.rec.isWatching(), 'after the cooldown');
});

test('re-arming during a watch does not reset the ladder (soft kicks rate-limited)', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  for (var i = 0; i < 30; i++) {
    env.rec.onEvent('playlist-switch', { channel: 'c', to: i % 2 ? 'stripped' : 'backup:popout', matched: false });
    env.step(1000);
  }
  assert.ok(env.kicks <= rc.maxSoftKicks, 'kicks: ' + env.kicks);
  assert.ok(env.reloads <= 1);
});

test('break ended with a backup of the native quality: soft recovery only, no hard reload', function () {
  var env = makeEnv();
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'backup', matched: true });
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'native' });
  env.run(60000);
  assert.equal(env.kicks, rc.maxSoftKicks);
  assert.equal(env.reloads, 0);
  assert.notOk(env.rec.isWatching());
});

test('break that stripped segments: hard reload allowed', function () {
  var env = makeEnv();
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  env.run(40000);
  assert.equal(env.reloads, 1);
});

test('waiting/stalled re-arm while a backup is served and shortly after native returns, not later', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'backup:popout', matched: true });
  for (var i = 0; i < 25; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.notOk(env.rec.isWatching());
  env.fire('waiting');
  assert.ok(env.rec.isWatching(), 'serving backup');
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'native' });
  for (var j = 0; j < 25; j++) { env.video.currentTime += 1; env.step(1000); }
  env.fire('stalled');
  assert.ok(env.rec.isWatching(), 'just back on native');
  for (var k = 0; k < 40; k++) { env.video.currentTime += 1; env.step(1000); }
  assert.notOk(env.rec.isWatching());
  env.fire('waiting');
  assert.notOk(env.rec.isWatching(), 'long after: ordinary buffering is the player\'s business');
});

test('hidden tab: nothing is done', function () {
  var env = makeEnv();
  env.doc.visibilityState = 'hidden';
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.video.paused = true;
  env.fire('pause');
  env.run(30000);
  assert.equal(env.kicks + env.plays + env.reloads, 0);
});

test('segment-repeat: one pause/play restart, rate limited', function () {
  var env = makeEnv();
  env.rec.onEvent('segment-repeat', { channel: 'c' });
  assert.equal(env.kicks, 1);
  assert.equal(env.plays, 1);
  env.rec.onEvent('segment-repeat', { channel: 'c' });
  env.t += rc.repeatRestartMinIntervalMs - 1;
  env.rec.onEvent('segment-repeat', { channel: 'c' });
  assert.equal(env.kicks, 1);
  env.t += 2;
  env.rec.onEvent('segment-repeat', { channel: 'c' });
  assert.equal(env.kicks, 2);
  // Our own pause is not taken for an unexpected one (no re-arm).
  env.video.paused = true;
  env.fire('pause');
  assert.notOk(env.rec.isWatching());
});

test('reload rate limit: 4th stall within the window degrades the channel instead of reloading', function () {
  var env = makeEnv();
  for (var i = 0; i < rc.maxReloadsPerWindow; i++) stallThroughReload(env, 'c');
  assert.equal(env.reloads, rc.maxReloadsPerWindow);
  stallThroughReload(env, 'c');
  assert.equal(env.reloads, rc.maxReloadsPerWindow, 'no extra reload');
  assert.deepEqual(env.degraded, ['c']);
  assert.ok(env.rec.isDegraded('c'));
  stallThroughReload(env, 'c');
  assert.equal(env.reloads, rc.maxReloadsPerWindow);
  assert.deepEqual(env.degraded, ['c']);
});

test('rate limit is per channel and the window slides', function () {
  var env = makeEnv();
  for (var i = 0; i < rc.maxReloadsPerWindow; i++) stallThroughReload(env, 'a');
  stallThroughReload(env, 'b');
  assert.equal(env.reloads, rc.maxReloadsPerWindow + 1);
  env.t += rc.reloadWindowMs + 1;
  stallThroughReload(env, 'a');
  assert.equal(env.reloads, rc.maxReloadsPerWindow + 2);
  assert.deepEqual(env.degraded, []);
});

test('player state not found: reload-failed reported, no exception', function () {
  var env = makeEnv(undefined, { finder: function () { return null; } });
  stallThroughReload(env, 'c');
  assert.ok(env.events.indexOf('reload-failed') !== -1);
});

test('exception inside tick disarms instead of throwing', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.doc.querySelectorAll = function () { throw new Error('boom'); };
  env.step(1000);
  assert.notOk(env.rec.isWatching());
});

test('findPlayerAndState walks a React fiber tree (legacy root and __reactContainer key)', function () {
  var player = { play: function () {} };
  var state = { setSrc: function () {}, setInitialPlaybackSettings: function () {} };
  var tree = { child: { stateNode: {}, sibling: { stateNode: { setPlayerActive: function () {}, props: { mediaPlayerInstance: { playerInstance: player } } }, child: { stateNode: state } } } };
  var rootLegacy = { _reactRootContainer: { _internalRoot: { current: tree } } };
  var doc = { querySelector: function () { return rootLegacy; } };
  var r = ns.recovery.findPlayerAndState(doc, cfg);
  assert.ok(r.player === player);
  assert.ok(r.state === state);
  var rootNew = { '__reactContainer$xyz': tree };
  var r2 = ns.recovery.findPlayerAndState({ querySelector: function () { return rootNew; } }, cfg);
  assert.ok(r2.state === state);
  assert.equal(ns.recovery.findPlayerAndState({ querySelector: function () { return null; } }, cfg), null);
});

test('reload limiter counts within the window only', function () {
  var t = 0;
  var L = ns.recovery.createReloadLimiter(2, 100, function () { return t; });
  assert.ok(L.allow('x'));
  assert.ok(L.allow('x'));
  assert.notOk(L.allow('x'));
  t = 101;
  assert.ok(L.allow('x'));
  assert.equal(L.count('x'), 1);
});

test('switched off: switch/ad-end/pause events arm nothing, stalls touch nothing', function () {
  var on = false;
  var env = makeEnv(function () { return on; });
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  env.rec.onEvent('segment-repeat', { channel: 'c' });
  env.video.paused = true;
  env.fire('pause');
  env.fire('waiting');
  assert.equal(env.intervals, 0, 'no timer');
  assert.notOk(env.rec.isWatching());
  env.run(30000);
  assert.equal(env.kicks + env.plays + env.reloads, 0);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.degraded, []);
});

test('switched off during a watch: next tick disarms, no kick, no reload, no degrade', function () {
  var on = true;
  var env = makeEnv(function () { return on; });
  env.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  assert.ok(env.rec.isWatching());
  on = false;
  env.step(1000);
  assert.notOk(env.rec.isWatching());
  assert.equal(env.cleared, 1);
  env.run(30000);
  assert.equal(env.kicks, 0);
  assert.equal(env.reloads, 0);
  assert.deepEqual(env.degraded, []);
});

test('switched off with the reload limit exhausted: no degrade', function () {
  var on = true;
  var env = makeEnv(function () { return on; });
  for (var i = 0; i < rc.maxReloadsPerWindow; i++) stallThroughReload(env, 'c');
  on = false;
  stallThroughReload(env, 'c');
  assert.deepEqual(env.degraded, []);
  assert.equal(env.reloads, rc.maxReloadsPerWindow);
});

// ---- Frozen picture: audio clock moves currentTime, but no video frames are decoded ----

/** Give the fake video a decoded-frame counter (getVideoPlaybackQuality). */
function withFrames(env, frames) {
  env.frames = frames || 0;
  env.video.videoWidth = 1280;
  env.video.getVideoPlaybackQuality = function () { return { totalVideoFrames: env.frames }; };
  return env;
}

/** One tick of playback: currentTime +1 s, frames += fps (0 = frozen picture). */
function play(env, fps, ticks) {
  for (var i = 0; i < (ticks || 1); i++) {
    env.video.currentTime += 1;
    env.frames += fps;
    env.step(1000);
  }
}

test('frozen picture (time advancing, frames flat): nudge after frozenPictureTicks, then a hard reload even for a soft watch', function () {
  var env = withFrames(makeEnv(), 100);
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'none' }); // soft-armed watch
  play(env, 0, rc.frozenPictureTicks - 1);
  assert.equal(env.kicks, 0, 'not before frozenPictureTicks');
  play(env, 0, 1);
  assert.equal(env.kicks, 1, 'pause/play nudge');
  assert.equal(env.plays, 1);
  assert.deepEqual(env.actions(), ['frozen-picture']);
  var firstSoftAt = env.t;
  while (env.t < firstSoftAt + rc.hardReloadAfterMs - 1000) play(env, 0, 1);
  assert.equal(env.reloads, 0, 'not before hardReloadAfterMs');
  assert.ok(env.kicks <= rc.maxSoftKicks);
  play(env, 0, 1);
  assert.equal(env.reloads, 1, 'hard reload for a frozen picture');
  play(env, 0, rc.frozenPictureTicks + 2);
  assert.equal(env.reloads, 1, 'only one reload');
  assert.notOk(env.rec.isWatching(), 'gave up');
});

test('frozen picture via webkitDecodedFrameCount when getVideoPlaybackQuality is missing', function () {
  var env = makeEnv();
  env.video.webkitDecodedFrameCount = 50;
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  for (var i = 0; i < rc.frozenPictureTicks; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.equal(env.kicks, 1);
});

test('videoWidth 0 while audio advances (no video track): treated as a frozen picture', function () {
  var env = withFrames(makeEnv());
  env.video.videoWidth = 0;
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  play(env, 30, rc.frozenPictureTicks);
  assert.equal(env.kicks, 1);
  assert.deepEqual(env.actions(), ['frozen-picture']);
});

test('viewer chose audio-only quality: frozen picture is left alone', function () {
  var env = withFrames(makeEnv(undefined, { store: { 'video-quality': '{"default":"audio_only"}' } }));
  env.video.videoWidth = 0;
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  play(env, 0, 40);
  assert.equal(env.kicks + env.plays + env.reloads, 0);
});

test('unparsable video-quality value is not audio-only', function () {
  var env = withFrames(makeEnv(undefined, { store: { 'video-quality': '{audio_only' } }));
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  play(env, 0, rc.frozenPictureTicks);
  assert.equal(env.kicks, 1);
});

test('frames advancing normally: no action; a good tick resets the frozen counter', function () {
  var env = withFrames(makeEnv());
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  play(env, 30, 10);
  assert.equal(env.kicks, 0);
  for (var i = 0; i < 6; i++) {
    play(env, 0, rc.frozenPictureTicks - 1);
    play(env, 30, 1);
  }
  assert.equal(env.kicks + env.plays + env.reloads, 0, 'never 4 frozen ticks in a row');
});

test('no decoded-frame counter: frozen picture is not detected (old behaviour)', function () {
  var env = makeEnv();
  env.video.videoWidth = 0;
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  for (var i = 0; i < 40; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.equal(env.kicks + env.plays + env.reloads, 0);
});

test('frozen picture in a hidden tab: nothing is done', function () {
  var env = withFrames(makeEnv());
  env.doc.visibilityState = 'hidden';
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  play(env, 0, 30);
  assert.equal(env.kicks + env.plays + env.reloads, 0);
});

test('ad-end watch lasts frozenPictureWatchMs; a playlist-switch watch keeps watchWindowMs', function () {
  assert.equal(rc.frozenPictureWatchMs, 40000);
  var env = withFrames(makeEnv());
  env.rec.onEvent('ad-end', { channel: 'c', outcome: 'stripped' });
  assert.equal(env.intervals, 1);
  play(env, 30, rc.frozenPictureWatchMs / 1000 - 1);
  assert.ok(env.rec.isWatching(), 'still watching before frozenPictureWatchMs');
  play(env, 30, 2);
  assert.notOk(env.rec.isWatching(), 'watch over');
  var env2 = withFrames(makeEnv());
  env2.rec.onEvent('playlist-switch', { channel: 'c', to: 'stripped' });
  play(env2, 30, rc.watchWindowMs / 1000 + 1);
  assert.notOk(env2.rec.isWatching());
});
