/* Recovery: stall detection after a playlist switch, soft kick, rate-limited reload, degrade. */
loadSrc('src/config.js', 'src/shared/logger.js', 'src/page/recovery.js');
var ns = __TAS__;
var cfg = ns.config;
var rc = cfg.recovery;
var quietLog = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function makeEnv(isEnabled) {
  var env = { t: 0, events: [], degraded: [], reloads: 0, kicks: 0, intervals: 0, cleared: 0 };
  env.video = {
    currentSrc: 'blob:https://www.twitch.tv/abc', src: '', currentTime: 10, paused: false, ended: false,
    pause: function () { env.kicks++; }, play: function () { return Promise.resolve(); }
  };
  env.doc = { querySelectorAll: function () { return [env.video]; }, querySelector: function () { return null; } };
  env.state = { setSrc: function (o) { env.reloads++; env.lastSetSrc = o; }, setInitialPlaybackSettings: function () {} };
  env.player = { play: function () {}, isPaused: function () { return false; } };
  env.storage = {};
  env.rec = ns.recovery.createRecovery({
    cfg: cfg, log: quietLog, doc: env.doc,
    win: { localStorage: null, setTimeout: function () {} },
    now: function () { return env.t; },
    setInterval: function () { env.intervals++; return 1; },
    clearInterval: function () { env.cleared++; },
    emit: function (n, d) { env.events.push(n); },
    onDegrade: function (ch) { env.degraded.push(ch); },
    findPlayerAndState: function () { return { player: env.player, state: env.state }; },
    isEnabled: isEnabled
  });
  env.step = function (ms) { env.t += ms; env.rec.tick(); };
  return env;
}

function stallThroughReload(env, ch) {
  env.rec.onEvent('playlist-switch', { channel: ch });
  env.step(rc.stallThresholdMs + 1); // soft kick
  env.step(rc.stallThresholdMs + 1); // reload (or degrade)
}

test('no timer until a playlist switch arms the watch', function () {
  var env = makeEnv();
  assert.equal(env.intervals, 0);
  env.rec.onEvent('ad-detected', { channel: 'c' });
  assert.equal(env.intervals, 0);
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  assert.equal(env.intervals, 1);
  assert.ok(env.rec.isWatching());
});

test('advancing video: nothing happens and the watch ends after the window', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  for (var i = 0; i < 10; i++) { env.video.currentTime += 1; env.step(1000); }
  assert.equal(env.kicks, 0);
  env.step(rc.watchWindowMs);
  assert.notOk(env.rec.isWatching());
  assert.equal(env.cleared, 1);
});

test('paused by the user is not a stall', function () {
  var env = makeEnv();
  env.video.paused = true;
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  env.step(rc.stallThresholdMs + 1);
  env.step(rc.stallThresholdMs + 1);
  assert.equal(env.kicks, 0);
  assert.equal(env.reloads, 0);
});

test('stall: pause/play first, then player reload with refreshed token, then stop', function () {
  var env = makeEnv();
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  env.step(1000);
  assert.equal(env.kicks, 0);
  env.step(rc.stallThresholdMs);
  assert.equal(env.kicks, 1, 'soft kick');
  assert.equal(env.reloads, 0);
  env.step(rc.stallThresholdMs + 1);
  assert.equal(env.reloads, 1, 'hard reload');
  assert.deepEqual(env.lastSetSrc, { isNewMediaPlayerInstance: true, refreshAccessToken: true });
  assert.ok(env.events.indexOf('player-reload') !== -1);
  env.step(rc.stallThresholdMs + 1);
  assert.notOk(env.rec.isWatching(), 'gives up after one reload per switch');
  assert.equal(env.reloads, 1);
});

test('reload rate limit: 4th stall within the window degrades the channel instead of reloading', function () {
  var env = makeEnv();
  for (var i = 0; i < rc.maxReloadsPerWindow; i++) { stallThroughReload(env, 'c'); env.t += 1000; }
  assert.equal(env.reloads, rc.maxReloadsPerWindow);
  stallThroughReload(env, 'c');
  assert.equal(env.reloads, rc.maxReloadsPerWindow, 'no extra reload');
  assert.deepEqual(env.degraded, ['c']);
  assert.ok(env.rec.isDegraded('c'));
  // Degraded: later stalls only get a soft kick, never a reload, and degrade is reported once.
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
  var env = makeEnv();
  var rec = ns.recovery.createRecovery({
    cfg: cfg, log: quietLog, doc: env.doc, win: {}, now: function () { return env.t; },
    setInterval: function () { return 1; }, clearInterval: function () {},
    emit: function (n) { env.events.push(n); }, onDegrade: function () {},
    findPlayerAndState: function () { return null; }
  });
  rec.onEvent('playlist-switch', { channel: 'c' });
  env.t += rc.stallThresholdMs + 1; rec.tick();
  env.t += rc.stallThresholdMs + 1; rec.tick();
  assert.ok(env.events.indexOf('reload-failed') !== -1);
});

test('exception inside tick disarms instead of throwing', function () {
  var env = makeEnv();
  env.doc.querySelectorAll = function () { throw new Error('boom'); };
  env.rec.onEvent('playlist-switch', { channel: 'c' });
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

test('switched off: switch/ad-end events arm nothing, stalls touch nothing', function () {
  var on = false;
  var env = makeEnv(function () { return on; });
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  env.rec.onEvent('ad-end', { channel: 'c' });
  assert.equal(env.intervals, 0, 'no timer');
  assert.notOk(env.rec.isWatching());
  for (var i = 0; i < 4; i++) env.step(rc.stallThresholdMs + 1);
  assert.equal(env.kicks, 0);
  assert.equal(env.reloads, 0);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.degraded, []);
});

test('switched off during a watch: next tick disarms, no kick, no reload, no degrade', function () {
  var on = true;
  var env = makeEnv(function () { return on; });
  env.rec.onEvent('playlist-switch', { channel: 'c' });
  assert.ok(env.rec.isWatching());
  on = false;
  env.step(rc.stallThresholdMs + 1);
  assert.notOk(env.rec.isWatching());
  assert.equal(env.cleared, 1);
  env.step(rc.stallThresholdMs + 1);
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
