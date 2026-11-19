/*
 * Page script (MAIN world) against browser stubs: Worker wrapping, the playerType rewrite and
 * playback health must all stand down once the bridge reports settings.enabled === false.
 * Health samples the video only while it plays: no timer otherwise, no player action here.
 * One page.js install per jsc process (it has an install guard), so the tests run in order.
 */
load('tests/lib/browser-stubs.js');
var env = installBrowserStubs();
loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/logger.js', 'src/shared/frame.js',
  'src/core/m3u8.js', 'src/core/gql.js', 'src/core/processor.js', 'src/worker/worker-main.js',
  'src/core/worker-source.js', 'src/page/health.js');
var cfg = __TAS__.config;
var S = __TAS__.settings;
var KEY = cfg.messageKey;
var stubFetch = globalThis.fetch;
load('src/page/page.js');

var TWITCH_WORKER = 'https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min.js';
var TOKEN_BODY = JSON.stringify({
  operationName: cfg.gql.operationName,
  variables: { isLive: true, isVod: false, login: 'somechannel', playerType: cfg.forcedPlayerTypeFrom[0] }
});

function settingsWith(enabled) {
  var s = S.defaults();
  s.enabled = enabled;
  return s;
}

function workerSays(w, msg) {
  var d = {};
  d[KEY] = msg;
  w.listeners.forEach(function (fn) { fn({ data: d, stopImmediatePropagation: function () {} }); });
}

function timerCount() { return Object.keys(__timers.list).length; }

// The player's main <video> (MSE: blob: source), found by health.js through the document.
var video = { nodeName: 'VIDEO', currentSrc: 'blob:https://www.twitch.tv/v', src: '', currentTime: 5, paused: false, ended: false,
  pause: function () { throw new Error('page tests must not touch the player'); },
  play: function () { throw new Error('page tests must not touch the player'); } };
document.querySelectorAll = function (sel) { return sel === cfg.player.videoSelector ? [video] : []; };
function mediaEvent(type) { document.dispatchEvent({ type: type, target: video, isTrusted: true }); }

test('hooks installed: fetch and Worker replaced, namespace removed, hello sent', function () {
  assert.ok(globalThis.fetch !== stubFetch, 'fetch hooked');
  assert.ok(globalThis.Worker !== env.OriginalWorker, 'Worker hooked');
  assert.equal(typeof globalThis.__TAS__, 'undefined');
  var hellos = env.messages(cfg.events.toBridge).filter(function (m) { return m.type === 'hello'; });
  assert.equal(hellos.length, 1);
});

test('before settings arrive: Twitch workers are wrapped (worker code checks enabled itself)', function () {
  var w = new Worker(TWITCH_WORKER);
  assert.equal(w.scriptURL.indexOf('blob:'), 0, 'wrapped blob URL');
  assert.includes(env.blobs[w.scriptURL].text, '__TAS_WORKER__');
  assert.includes(env.blobs[w.scriptURL].text, 'self.twitchWorker = 1;');
  assert.ok(w instanceof env.OriginalWorker);
});

test('enabled: page token request playerType is rewritten', function () {
  return fetch(cfg.gql.url, { method: 'POST', body: TOKEN_BODY }).then(function () {
    var last = env.fetches[env.fetches.length - 1];
    assert.includes(last.init.body, '"playerType":"' + cfg.forcedPlayerType + '"');
  });
});

test('disabled settings received: existing workers told, new workers not wrapped', function () {
  var existing = env.workers[0];
  var before = existing.posted.length;
  env.toPage(cfg, { type: 'settings', settings: settingsWith(false) });
  var sent = existing.posted.slice(before).map(function (m) { return m[KEY]; });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'settings');
  assert.equal(sent[0].settings.enabled, false);

  var xhrBefore = env.xhrUrls.length;
  var w = new Worker(TWITCH_WORKER, { name: 'x' });
  assert.equal(w.scriptURL, TWITCH_WORKER, 'original script URL');
  assert.equal(w.options.name, 'x');
  assert.equal(env.xhrUrls.length, xhrBefore, 'worker source not even read');
  assert.equal(w.listeners.length, 0, 'no message listener attached');
});

test('disabled: page token request body passed through untouched', function () {
  return fetch(cfg.gql.url, { method: 'POST', body: TOKEN_BODY }).then(function () {
    var last = env.fetches[env.fetches.length - 1];
    assert.equal(last.init.body, TOKEN_BODY);
  });
});

test('disabled: in-flight worker token requests get null without a GQL request; health stays idle', function () {
  var w = env.workers[0];
  var fetchesBefore = env.fetches.length;
  var timersBefore = timerCount();
  workerSays(w, { type: 'token-request', id: 7, channel: 'somechannel', playerType: 'popout' });
  workerSays(w, { type: 'event', name: 'playlist-switch', data: { channel: 'somechannel' } });
  workerSays(w, { type: 'event', name: 'ad-end', data: { channel: 'somechannel' } });
  mediaEvent('playing');
  return Promise.resolve().then(function () {
    assert.equal(env.fetches.length, fetchesBefore, 'no token fetch');
    var reply = w.posted.map(function (m) { return m[KEY]; }).filter(function (m) { return m.type === 'token-response'; });
    assert.equal(reply.length, 1);
    assert.equal(reply[0].id, 7);
    assert.equal(reply[0].token, null);
    assert.equal(timerCount(), timersBefore, 'health started no sampling timer');
  });
});

test('re-enabled: new workers are wrapped again; health samples only while the video plays', function () {
  env.toPage(cfg, { type: 'settings', settings: settingsWith(true) });
  var w = new Worker(TWITCH_WORKER);
  assert.equal(w.scriptURL.indexOf('blob:'), 0);
  var timersBefore = timerCount();
  video.paused = true;
  workerSays(w, { type: 'event', name: 'playlist-switch', data: { channel: 'somechannel', to: 'stripped' } });
  assert.equal(timerCount(), timersBefore, 'paused video: no timer');
  video.paused = false;
  mediaEvent('playing');
  assert.equal(timerCount(), timersBefore + 1, 'playing video: one sampling timer');
  workerSays(w, { type: 'event', name: 'playlist-switch', data: { channel: 'somechannel', to: 'native' } });
  assert.equal(timerCount(), timersBefore + 1, 'still one timer');
  // Health events are debug-only: none reach the bridge with debug off.
  video.currentTime += 1;
  __advanceTimers(cfg.health.reportMs);
  assert.equal(env.messages(cfg.events.toBridge).filter(function (m) { return m.name === 'health'; }).length, 0);
  // Switching off while sampling: the next sample stops the timer without touching the player.
  env.toPage(cfg, { type: 'settings', settings: settingsWith(false) });
  __advanceTimers(cfg.health.sampleMs);
  assert.equal(timerCount(), timersBefore, 'sampling timer cleared');
});

test('no degrade message to workers any more (strip-only mode was recovery-only)', function () {
  env.workers.forEach(function (x) {
    x.posted.forEach(function (m) { assert.ok(m[KEY].type !== 'degrade'); });
  });
  var hellos = env.messages(cfg.events.toBridge).filter(function (m) { return m.type === 'hello'; });
  assert.equal(hellos[0].degraded, undefined);
});
