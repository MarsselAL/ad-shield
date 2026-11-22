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

// Parallel backup search (Purple d9cafb2): the worker asks for several playerTypes at once; each
// gets its own GQL request right away (no queue), with the playerType the worker asked for.
test('enabled: concurrent worker token requests each start their own GQL request at once', function () {
  env.toPage(cfg, { type: 'settings', settings: settingsWith(true) });
  var w = new Worker(TWITCH_WORKER);
  var before = env.fetches.length;
  var types = ['embed', 'site', 'mobile_web'];
  types.forEach(function (t, i) { workerSays(w, { type: 'token-request', id: 30 + i, channel: 'somechannel', playerType: t }); });
  var sent = env.fetches.slice(before);
  assert.equal(sent.length, 3, 'all three requested synchronously');
  sent.forEach(function (f, i) {
    assert.equal(f.input, cfg.gql.url);
    assert.includes(f.init.body, '"playerType":"' + types[i] + '"', 'not rewritten to the page token type');
  });
  var p = Promise.resolve();
  for (var k = 0; k < 12; k++) p = p.then(function () {});
  return p.then(function () {
    var replies = w.posted.map(function (m) { return m[KEY]; }).filter(function (m) { return m.type === 'token-response'; });
    assert.deepEqual(replies.map(function (m) { return m.id; }).sort(), [30, 31, 32]);
  });
});

// Persisted query hash fallback (gql.fetchToken): the retry carries the same captured page headers.
test('enabled: PersistedQueryNotFound -> retried with the next hash, captured page headers on both', function () {
  env.toPage(cfg, { type: 'settings', settings: settingsWith(true) });
  return fetch(cfg.gql.url, { method: 'POST', headers: { 'Client-Integrity': 'ci-1', Authorization: 'OAuth zz', 'X-Device-Id': 'dev-1' }, body: '{}' }).then(function () {
    var hashes = cfg.gql.persistedQueryHashes;
    env.fetchJson = function (input, init) {
      var b = JSON.parse(init.body);
      return b.extensions.persistedQuery.sha256Hash === hashes[0]
        ? { errors: [{ message: 'PersistedQueryNotFound' }] }
        : { data: { streamPlaybackAccessToken: { value: 'tv', signature: 'ts' } } };
    };
    var w = new Worker(TWITCH_WORKER);
    var before = env.fetches.length;
    workerSays(w, { type: 'token-request', id: 51, channel: 'somechannel', playerType: 'embed' });
    var p = Promise.resolve();
    for (var k = 0; k < 16; k++) p = p.then(function () {});
    return p.then(function () {
      env.fetchJson = null;
      var sent = env.fetches.slice(before);
      assert.equal(sent.length, 2, 'one retry');
      assert.deepEqual(sent.map(function (f) { return JSON.parse(f.init.body).extensions.persistedQuery.sha256Hash; }), hashes.slice(0, 2));
      sent.forEach(function (f) {
        assert.equal(f.init.headers['Client-Integrity'], 'ci-1');
        assert.equal(f.init.headers.Authorization, 'OAuth zz');
        assert.equal(f.init.headers['X-Device-Id'], 'dev-1');
      });
      var reply = w.posted.map(function (m) { return m[KEY]; }).filter(function (m) { return m.type === 'token-response' && m.id === 51; });
      assert.deepEqual(reply[0].token, { value: 'tv', signature: 'ts' });
    });
  });
});

test('client-side ad requests: answered locally on VOD pages only (fetch 204, XHR empty VAST); live, POST, off: sent', function () {
  env.toPage(cfg, { type: 'settings', settings: settingsWith(true) });
  globalThis.Response = function (body, init) { this.body = body; this.status = init.status; this.statusText = init.statusText; };
  var AD = 'https://edge.ads.twitch.tv/ads?bp=preroll&sid=abc';
  var VAES = 'https://vaes.amazon-adsystem.com/2018-01-01/3p/ads?x=1';
  var loc = globalThis.location;
  var saved = { pathname: loc.pathname, search: loc.search };
  function sent(url, init) {
    var before = env.fetches.length;
    return fetch(url, init).then(function (r) { return { sent: env.fetches.length - before, status: r.status }; });
  }
  function xhrUrl(method, url) { var x = new XMLHttpRequest(); x.open(method, url, true); return x.url; }
  // live channel page
  loc.pathname = '/somechannel'; loc.search = '';
  return sent(AD).then(function (r) {
    assert.deepEqual(r, { sent: 1, status: 200 }, 'live: ad request goes out');
    assert.equal(xhrUrl('GET', AD), AD, 'live: XHR untouched');
    loc.pathname = '/videos/2345678901';
    return sent(AD);
  }).then(function (r) {
    assert.deepEqual(r, { sent: 0, status: 204 }, 'VOD: answered locally with 204');
    assert.equal(xhrUrl('GET', VAES), 'data:application/xml,%3CVAST%20version%3D%223.0%22%3E%3C%2FVAST%3E', 'VOD: XHR gets an empty VAST');
    assert.equal(xhrUrl('POST', AD), AD, 'VOD: POST XHR untouched');
    return sent({ url: VAES, method: 'GET' });
  }).then(function (r) {
    assert.deepEqual(r, { sent: 0, status: 204 }, 'VOD: Request object');
    return sent(AD, { method: 'POST' });
  }).then(function (r) {
    assert.equal(r.sent, 1, 'VOD: POST goes out');
    return sent('https://edge.ads.twitch.tv/other');
  }).then(function (r) {
    assert.equal(r.sent, 1, 'VOD: other edge.ads paths go out');
    // the embedded player: player.twitch.tv/?video=v123
    loc.pathname = '/'; loc.search = '?video=v2345678901&parent=example.com';
    return sent(AD);
  }).then(function (r) {
    assert.equal(r.sent, 0, 'embedded VOD player');
    loc.search = '?channel=somechannel&parent=example.com';
    return sent(AD);
  }).then(function (r) {
    assert.equal(r.sent, 1, 'embedded live player: sent');
    loc.pathname = '/videos/2345678901'; loc.search = '';
    var s = settingsWith(true); s.blockClientAds = false;
    env.toPage(cfg, { type: 'settings', settings: s });
    return sent(AD);
  }).then(function (r) {
    assert.equal(r.sent, 1, 'blockClientAds off: sent');
    assert.equal(xhrUrl('GET', AD), AD);
    env.toPage(cfg, { type: 'settings', settings: settingsWith(false) });
    return sent(AD);
  }).then(function (r) {
    assert.equal(r.sent, 1, 'switched off: sent');
    env.toPage(cfg, { type: 'settings', settings: settingsWith(true) });
    loc.pathname = saved.pathname; loc.search = saved.search;
  });
});
