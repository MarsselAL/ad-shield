/*
 * Worker blob builder: the generated source must compile (new Function) and, when run against
 * a fake worker global with a fake fetch, hook fetch correctly. No network.
 */
loadSrc('src/config.js', 'src/shared/logger.js', 'src/core/m3u8.js', 'src/core/processor.js',
  'src/worker/worker-main.js', 'src/core/worker-source.js');
var ns = __TAS__;
var cfg = ns.config;
var KEY = cfg.messageKey;
var parts = { m3u8Factory: ns.m3u8Factory, processorFactory: ns.processorFactory, loggerFactory: ns.loggerFactory, workerMain: ns.workerMain };
// 'full': the tests below check the 2.0 order; the low-quality bridge (the default) has its own test.
var boot = { settings: { playerTypes: cfg.backupPlayerTypes.slice(), preferAvc: true, debug: false, twitchAdQuality: 'full' } };

var MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/somechannel.m3u8?allow_source=true&parent_domains=example.invalid&sig=S&token=T';
var MASTER = fixture('master.m3u8');
var PREROLL = fixture('preroll.m3u8');
var CLEAN = fixture('clean.m3u8');
var NATIVE_720 = 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-720p60.m3u8';
var EMBED_CLEAN = CLEAN.replace(/SYNTH-live/g, 'SYNTH-embed-live');
function segUrls(text) { return String(text).split('\n').filter(function (l) { return l && l.charAt(0) !== '#'; }); }

// ---- minimal Response stand-in (jsc has no fetch API)
function FakeResponse(body, init) {
  init = init || {};
  this.body = body;
  this.status = init.status === undefined ? 200 : init.status;
  this.statusText = init.statusText || '';
  this.headers = init.headers || {};
}
FakeResponse.prototype.text = function () { return Promise.resolve(typeof this.body === 'string' ? this.body : ''); };
FakeResponse.prototype.clone = function () { return new FakeResponse(this.body, this); };
globalThis.Response = FakeResponse;

function makeScope(routes) {
  var scope = { listeners: [], posted: [], realCalls: [] };
  scope.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    scope.realCalls.push(url);
    var m = /[?&]token=tok-([a-z_-]+)/.exec(url);
    if (url.indexOf('https://usher.ttvnw.net/') === 0 && m) {
      return Promise.resolve(new FakeResponse(MASTER.replace(/SYNTH-/g, 'SYNTH-' + m[1] + '-')));
    }
    if (routes[url] !== undefined) return Promise.resolve(new FakeResponse(routes[url]));
    return Promise.resolve(new FakeResponse('not found', { status: 404 }));
  };
  scope.addEventListener = function (type, fn) { if (type === 'message') scope.listeners.push(fn); };
  scope.dispatch = function (data) {
    var stopped = false;
    var ev = { data: data, stopImmediatePropagation: function () { stopped = true; } };
    scope.listeners.forEach(function (fn) { fn(ev); });
    return stopped;
  };
  scope.postMessage = function (m) {
    scope.posted.push(m);
    var msg = m[KEY];
    if (msg && msg.type === 'token-request') {
      Promise.resolve().then(function () {
        var reply = {};
        reply[KEY] = { type: 'token-response', id: msg.id, token: { value: 'tok-' + msg.playerType, signature: 'sig-' + msg.playerType } };
        scope.dispatch(reply);
      });
    }
  };
  return scope;
}

function runInWorker(scope, original) {
  var src = ns.buildWorkerSource(parts, cfg, boot, original || 'self.__originalRan = (self.__originalRan || 0) + 1;');
  globalThis.self = scope;
  (new Function(src))();
  return src;
}

test('generated worker source is syntactically valid JS', function () {
  var src = ns.buildWorkerSource(parts, cfg, boot, 'var twitchWorker = 1; function x() { return twitchWorker; }');
  var f = new Function(src); // throws SyntaxError if invalid
  assert.equal(typeof f, 'function');
  assert.ok(ns.isWrappedWorkerSource(src));
  assert.notOk(ns.isWrappedWorkerSource('var a = 1;'));
  assert.includes(src, '"messageKey"');
});

test('"use strict" directive of the original worker is hoisted to the top', function () {
  var src = ns.buildWorkerSource(parts, cfg, boot, '/* c */\n"use strict";\nvar a = 1;');
  assert.equal(src.indexOf('"use strict";'), 0);
  new Function(src);
  var src2 = ns.buildWorkerSource(parts, cfg, boot, 'var a = 1;');
  assert.notOk(/^"use strict"/.test(src2));
});

test('config JSON with "</script>"-like text is escaped safely', function () {
  var src = ns.buildWorkerSource(parts, cfg, { settings: { note: '</script><b>' } }, '');
  assert.notIncludes(src, '</script>');
  new Function(src);
});

test('builder rejects missing parts', function () {
  assert.throws(function () { ns.buildWorkerSource({}, cfg, boot, ''); });
});

test('worker runs the original source after installing hooks', function () {
  var scope = makeScope({});
  var orig = scope.fetch;
  runInWorker(scope);
  assert.equal(scope.__originalRan, 1);
  assert.ok(scope.fetch !== orig, 'fetch replaced');
});

test('non-Twitch request passes straight to the real fetch', function () {
  var scope = makeScope({ 'https://example.invalid/data.json': '{"a":1}' });
  runInWorker(scope);
  return scope.fetch('https://example.invalid/data.json').then(function (r) {
    return r.text();
  }).then(function (t) {
    assert.equal(t, '{"a":1}');
    assert.deepEqual(scope.realCalls, ['https://example.invalid/data.json']);
  });
});

test('master: parent_domains removed from the request, HEVC variants removed from the answer', function () {
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  var scope = makeScope(routes);
  runInWorker(scope);
  return scope.fetch(MASTER_URL).then(function (r) { return r.text(); }).then(function (t) {
    assert.notIncludes(scope.realCalls[0], 'parent_domains');
    assert.notIncludes(t, 'hevc');
    assert.includes(t, 'SYNTH-720p60.m3u8');
  });
});

test('media with ads: token via page message, clean embed backup served, event posted', function () {
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  routes[NATIVE_720] = PREROLL;
  routes['https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-popout-720p60.m3u8'] = PREROLL;
  routes['https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-embed-720p60.m3u8'] = EMBED_CLEAN;
  var scope = makeScope(routes);
  runInWorker(scope);
  return scope.fetch(MASTER_URL).then(function () {
    return scope.fetch(NATIVE_720);
  }).then(function (r) { return r.text(); }).then(function (t) {
    assert.deepEqual(segUrls(t), segUrls(EMBED_CLEAN));
    var msgs = scope.posted.map(function (m) { return m[KEY]; });
    var tokenReqs = msgs.filter(function (m) { return m.type === 'token-request'; }).map(function (m) { return m.playerType; });
    // embed: prewarmed when the master was seen; the media poll with ads asks every type at once.
    assert.deepEqual(tokenReqs, ['embed', 'site', 'mobile_web', 'autoplay'], 'default order: embed first, popout (the page token type) skipped, autoplay last');
    var events = msgs.filter(function (m) { return m.type === 'event'; }).map(function (m) { return m.name; });
    assert.ok(events.indexOf('ad-blocked-backup') !== -1);
  });
});

test('low quality (default): every HD type and autoplay have ads, picture-by-picture bridge served through the unhooked fetch', function () {
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  routes[NATIVE_720] = PREROLL;
  var W = 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-';
  ['embed', 'site', 'mobile_web', 'autoplay'].forEach(function (t) { routes[W + t + '-720p60.m3u8'] = PREROLL; });
  var PBP_CLEAN = CLEAN.replace(/SYNTH-live/g, 'SYNTH-picture-by-picture-live');
  routes[W + 'picture-by-picture-720p60.m3u8'] = PBP_CLEAN;
  var scope = makeScope(routes);
  var saved = boot;
  boot = { settings: { playerTypes: cfg.backupPlayerTypes.slice(), preferAvc: true, debug: false } };
  try { runInWorker(scope); } finally { boot = saved; }
  return scope.fetch(MASTER_URL).then(function () {
    return scope.fetch(NATIVE_720);
  }).then(function (r) { return r.text(); }).then(function (t) {
    assert.deepEqual(segUrls(t), segUrls(PBP_CLEAN));
    var reqs = ourMessages(scope, 'token-request').map(function (m) { return m.playerType; });
    assert.deepEqual(reqs.slice(0, 2), ['embed', 'autoplay'], 'prewarm: first HD + first bridge');
    assert.ok(reqs.indexOf('picture-by-picture') !== -1);
    assert.ok(scope.realCalls.some(function (u) { return u.indexOf('tok-picture-by-picture') !== -1; }), 'picture-by-picture usher fetched (not ignored)');
    var ev = ourMessages(scope, 'event').filter(function (m) { return m.name === 'ad-blocked-backup'; })[0];
    assert.equal(ev.data.playerType, 'picture-by-picture');
    assert.equal(ev.data.bridge, true);
  });
});

test('live master: answered without waiting for the backup prewarm (one embed token request)', function () {
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  var scope = makeScope(routes);
  scope.postMessage = function (m) { scope.posted.push(m); }; // the page never answers the token request
  runInWorker(scope);
  return scope.fetch(MASTER_URL).then(function (r) { return r.text(); }).then(function (t) {
    assert.includes(t, 'SYNTH-720p60.m3u8');
    var reqs = ourMessages(scope, 'token-request').map(function (m) { return m.playerType; });
    assert.deepEqual(reqs, ['embed']);
    return scope.fetch(MASTER_URL);
  }).then(function () {
    assert.equal(ourMessages(scope, 'token-request').length, 1, 'one prewarm per channel per backupMasterTtlMs');
  });
});

test('all backups have ads: stripped playlist served; ad segment fetch answered locally with blank TS', function () {
  // Three live segments stay after stripping (enough to serve stripped on a first poll).
  var seg106 = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-106.ts';
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  routes[NATIVE_720] = PREROLL.replace('#EXT-X-TWITCH-PREFETCH:' + seg106 + '\n',
    '#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:12.008Z\n#EXTINF:2.000,live\n' + seg106 + '\n');
  cfg.backupPlayerTypes.forEach(function (t) {
    routes['https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-' + t + '-720p60.m3u8'] = PREROLL;
  });
  var scope = makeScope(routes);
  runInWorker(scope);
  var adSeg = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-ad-100.ts';
  return scope.fetch(MASTER_URL).then(function () { return scope.fetch(NATIVE_720); })
    .then(function (r) { return r.text(); })
    .then(function (t) {
      assert.notIncludes(t, ',Amazon|');
      assert.includes(t, 'SYNTH-live-104.ts');
      assert.equal(segUrls(t).filter(function (u) { return u.indexOf('SYNTH-ad-') !== -1; }).length, 0, 'no ad segment listed');
      assert.notIncludes(t, '#EXT-X-TWITCH-PREFETCH', 'no prefetch hint into the ad');
      var before = scope.realCalls.length;
      return scope.fetch(adSeg).then(function (r) {
        assert.equal(scope.realCalls.length, before, 'no network request for the ad segment');
        assert.equal(r.status, 200);
        assert.equal(r.body.length, 188);
        assert.equal(r.body[0], 0x47);
        assert.equal(r.headers['Content-Type'], 'video/mp2t');
      });
    });
});

test('internal exception in the hook: request passed to the real fetch untouched', function () {
  var scope = makeScope({});
  runInWorker(scope);
  // An input whose .url getter throws the first time it is read: the hook fails, then the
  // original fetch must receive the very same input object.
  var reads = 0;
  var input = {};
  Object.defineProperty(input, 'url', { get: function () { reads++; if (reads === 1) throw new Error('boom'); return 'https://example.invalid/x'; } });
  return scope.fetch(input).then(function (r) {
    assert.equal(r.status, 404);
    assert.deepEqual(scope.realCalls, ['https://example.invalid/x']);
  });
});

test('our messages are consumed (stopImmediatePropagation); foreign messages are not', function () {
  var scope = makeScope({});
  runInWorker(scope);
  var ours = {};
  ours[KEY] = { type: 'settings', settings: boot.settings };
  assert.ok(scope.dispatch(ours));
  assert.notOk(scope.dispatch({ type: 'twitch-internal' }));
  assert.notOk(scope.dispatch('plain string'));
});

test('real fetch error status is passed through unchanged', function () {
  var scope = makeScope({});
  runInWorker(scope);
  return scope.fetch(MASTER_URL).then(function (r) { assert.equal(r.status, 404); });
});

test('settings.enabled=false at runtime: hook becomes passive (no processing)', function () {
  var routes = {};
  routes[MASTER_URL] = MASTER;
  var scope = makeScope(routes);
  runInWorker(scope);
  var off = {};
  off[KEY] = { type: 'settings', settings: { enabled: false, playerTypes: cfg.backupPlayerTypes.slice(), preferAvc: true } };
  scope.dispatch(off);
  return scope.fetch(MASTER_URL).then(function (r) { return r.text(); }).then(function (t) {
    assert.equal(t, MASTER, 'master untouched (HEVC kept)');
    assert.equal(scope.realCalls[0], MASTER_URL, 'parent_domains not removed');
  });
});

function offMessage() {
  var off = {};
  off[KEY] = { type: 'settings', settings: { enabled: false, playerTypes: cfg.backupPlayerTypes.slice(), preferAvc: true } };
  return off;
}

function adRoutes() {
  var routes = {};
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  routes[MASTER_URL] = MASTER;
  routes[NATIVE_720] = PREROLL;
  routes['https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-popout-720p60.m3u8'] = PREROLL;
  routes['https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-embed-720p60.m3u8'] = EMBED_CLEAN;
  return routes;
}

function ourMessages(scope, type) {
  return scope.posted.map(function (m) { return m[KEY]; }).filter(function (m) { return m && m.type === type; });
}

test('disabled from boot: master and media playlists pass through unchanged, no token requests', function () {
  var scope = makeScope(adRoutes());
  var src = ns.buildWorkerSource(parts, cfg, { settings: { enabled: false, playerTypes: cfg.backupPlayerTypes.slice() } }, '');
  globalThis.self = scope;
  (new Function(src))();
  return scope.fetch(MASTER_URL).then(function (r) { return r.text(); }).then(function (t) {
    assert.equal(t, MASTER);
    return scope.fetch(NATIVE_720);
  }).then(function (r) { return r.text(); }).then(function (t) {
    assert.equal(t, PREROLL, 'ads left in place');
    assert.deepEqual(scope.realCalls, [MASTER_URL, NATIVE_720]);
    assert.equal(ourMessages(scope, 'token-request').length, 0);
    assert.equal(ourMessages(scope, 'event').length, 0);
  });
});

test('switched off after playlists are tracked: media and ad segments go to the network untouched', function () {
  var scope = makeScope(adRoutes());
  runInWorker(scope);
  var adSeg = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-ad-100.ts';
  return scope.fetch(MASTER_URL).then(function () { return scope.fetch(NATIVE_720); }).then(function (r) {
    return r.text();
  }).then(function (t) {
    assert.deepEqual(segUrls(t), segUrls(EMBED_CLEAN), 'enabled: backup served (playlist now tracked)');
    scope.dispatch(offMessage());
    var calls = scope.realCalls.length;
    var tokens = ourMessages(scope, 'token-request').length;
    return scope.fetch(NATIVE_720).then(function (r) { return r.text(); }).then(function (t2) {
      assert.equal(t2, PREROLL, 'tracked media playlist passed through');
      assert.deepEqual(scope.realCalls.slice(calls), [NATIVE_720], 'only the original request');
      assert.equal(ourMessages(scope, 'token-request').length, tokens, 'no new token requests');
      return scope.fetch(adSeg);
    }).then(function (r) {
      assert.equal(r.status, 404, 'ad segment fetched from the network, not blanked');
      assert.equal(scope.realCalls[scope.realCalls.length - 1], adSeg);
    });
  });
});

test('switched off while a media playlist is being processed: original playlist served', function () {
  var scope = makeScope(adRoutes());
  runInWorker(scope);
  var origPost = scope.postMessage;
  scope.postMessage = function (m) {
    // The first token request of the media poll means processing has started: flip the switch
    // right then (the master's prewarm request comes before and is ignored).
    if (scope.armed && m[KEY] && m[KEY].type === 'token-request' && !scope.flipped) { scope.flipped = true; scope.dispatch(offMessage()); }
    return origPost.call(scope, m);
  };
  return scope.fetch(MASTER_URL).then(function () { scope.armed = true; return scope.fetch(NATIVE_720); }).then(function (r) {
    return r.text();
  }).then(function (t) {
    assert.ok(scope.flipped, 'switch flipped mid-processing');
    assert.equal(t, PREROLL, 'processed result discarded, original returned');
  });
});

test('switched off while a master request is in flight: original master served', function () {
  var scope = makeScope(adRoutes());
  runInWorker(scope);
  var p = scope.fetch(MASTER_URL);
  scope.dispatch(offMessage());
  return p.then(function (r) { return r.text(); }).then(function (t) {
    assert.equal(t, MASTER, 'HEVC variants kept');
  });
});

test('client-side ad requests: answered locally with an empty VAST (live and VOD) while blockClientAds is on', function () {
  var AD = 'https://edge.ads.twitch.tv/ads?bp=midroll';
  var routes = {};
  routes[AD] = '<VAST/>';
  routes[MASTER_URL.replace('&parent_domains=example.invalid', '')] = MASTER;
  var scope = makeScope(routes);
  runInWorker(scope);
  var calls;
  return scope.fetch(MASTER_URL).then(function () {
    calls = scope.realCalls.length;
    return scope.fetch(AD);
  }).then(function (r) {
    assert.equal(r.status, 200, 'live: answered');
    assert.equal(scope.realCalls.length, calls, 'live: no network request');
    return r.text();
  }).then(function (body) {
    assert.ok(/<VAST version="3.0"><\/VAST>/.test(body), 'empty VAST body');
    return scope.fetch(AD, { method: 'POST' });
  }).then(function () {
    assert.equal(scope.realCalls.length, calls + 1, 'POST sent');
    var off = {};
    off[KEY] = { type: 'settings', settings: { blockClientAds: false, playerTypes: cfg.backupPlayerTypes.slice() } };
    scope.dispatch(off);
    return scope.fetch(AD);
  }).then(function () {
    assert.equal(scope.realCalls.length, calls + 2, 'blockClientAds off: sent');
  });
});
