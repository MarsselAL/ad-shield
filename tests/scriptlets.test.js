/*
 * Our scriptlets (src/scriptlets/lib.js), the host runner (src/scriptlets/runner.js), the YouTube
 * rules (rules/scriptlets.json) and the generated bundle (build/scriptlets-main.js), against fake
 * window objects: own JSON / Response / fetch / XMLHttpRequest / Promise per test, so nothing the
 * harness uses is patched.
 */
loadSrc('src/scriptlets/lib.js', 'src/scriptlets/runner.js');
var L = asScriptlets;
var R = asScriptletRunner;
var RULES = JSON.parse(readFile('rules/scriptlets.json'));
var PLAYER = readFile('tests/fixtures/youtube-player.json');
var logs = [];
function log(name, msg) { logs.push(name + ': ' + msg); }
function run(win, name, args) { L.scriptlets[name](win, args || [], log); }
function flush() { var p = Promise.resolve(); for (var i = 0; i < 10; i++) p = p.then(function () {}); return p; }

// ------------------------------------------------------------------ fakes
function FakeHeaders(init) {
  this.map = {};
  var src = init && init.map ? init.map : (init || {});
  for (var k in src) this.map[k.toLowerCase()] = String(src[k]);
}
FakeHeaders.prototype.get = function (k) { k = k.toLowerCase(); return k in this.map ? this.map[k] : null; };
FakeHeaders.prototype.delete = function (k) { delete this.map[k.toLowerCase()]; };

function makeResponseClass() {
  function Resp(body, init) {
    init = init || {};
    this._body = body === undefined || body === null ? '' : String(body);
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText || '';
    this.headers = new FakeHeaders(init.headers);
    this.bodyUsed = false;
  }
  Object.defineProperty(Resp.prototype, 'url', { get: function () { return this._url || ''; }, configurable: true });
  Object.defineProperty(Resp.prototype, 'type', { get: function () { return this._type || 'default'; }, configurable: true });
  Resp.prototype.text = function () { this.bodyUsed = true; return Promise.resolve(this._body); };
  Resp.prototype.json = function () { return this.text().then(JSON.parse); };
  Resp.prototype.clone = function () {
    var r = new Resp(this._body, { status: this.status, statusText: this.statusText, headers: this.headers });
    r._url = this._url; r._type = this._type;
    return r;
  };
  return Resp;
}

function makeXhrClass(bodies) {
  function X() { this._rs = 0; this.responseType = ''; }
  X.prototype.open = function (m, url) { this._url = String(url); this._rs = 1; this._obj = undefined; };
  X.prototype.send = function () { this._raw = bodies[this._url] || ''; this._rs = 4; };
  Object.defineProperty(X.prototype, 'readyState', { get: function () { return this._rs; }, configurable: true });
  Object.defineProperty(X.prototype, 'responseText', {
    get: function () {
      if (this.responseType !== '' && this.responseType !== 'text') throw new Error('InvalidStateError');
      return this._rs === 4 ? this._raw : '';
    },
    configurable: true
  });
  Object.defineProperty(X.prototype, 'response', {
    get: function () {
      if (this.responseType === 'json') {
        if (this._rs !== 4) return null;
        if (this._obj === undefined) this._obj = JSON.parse(this._raw);
        return this._obj;
      }
      return this._rs === 4 ? this._raw : '';
    },
    configurable: true
  });
  return X;
}

/** A window-like object. opts.bodies: url -> response body for fetch / XHR. */
function fakeWin(host, opts) {
  opts = opts || {};
  var bodies = opts.bodies || {};
  var Resp = makeResponseClass();
  var win = {
    location: { hostname: host === undefined ? 'www.youtube.com' : host },
    document: opts.document,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Response: Resp,
    XMLHttpRequest: makeXhrClass(bodies),
    Promise: (function () { class P extends Promise {} return P; })(),
    fetched: [],
    timers: []
  };
  win.fetch = function fetch(input) {
    var url = typeof input === 'string' ? input : input.url;
    win.fetched.push(url);
    var r = new Resp(bodies[url] || '{}', { status: 203, statusText: 'Odd', headers: { 'content-type': 'application/json', 'content-length': '999' } });
    r._url = 'https://www.youtube.com' + url;
    r._type = 'basic';
    return Promise.resolve(r);
  };
  win.setTimeout = function (fn, ms) { win.timers.push({ fn: fn, ms: ms }); return win.timers.length; };
  return win;
}

function player() { return JSON.parse(PLAYER); }
function assertPlayerClean(o, msg) {
  assert.equal(o.adPlacements, undefined, (msg || '') + ' adPlacements');
  assert.equal(o.playerAds, undefined, (msg || '') + ' playerAds');
  assert.equal(o.adSlots, undefined, (msg || '') + ' adSlots');
  assert.equal(o.videoDetails.videoId, 'jNQXAC9IVRw', (msg || '') + ' videoDetails kept');
  assert.equal(o.streamingData.formats[0].itag, 18, (msg || '') + ' streamingData kept');
  assert.equal(o.playabilityStatus.status, 'OK');
}

function feed() {
  return {
    responseContext: {},
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
      { richItemRenderer: { content: { videoRenderer: { videoId: 'a' } } } },
      { richItemRenderer: { content: { adSlotRenderer: { adSlotMetadata: {} } } } },
      { richItemRenderer: { content: { videoRenderer: { videoId: 'b' } } } },
      { continuationItemRenderer: {} }
    ] } } } }] } },
    onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
      { richItemRenderer: { content: { adSlotRenderer: {} } } },
      { richItemRenderer: { content: { videoRenderer: { videoId: 'c' } } } }
    ] } }]
  };
}
function feedIds(o) {
  var grid = o.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;
  var more = o.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems;
  return grid.concat(more).map(function (x) {
    if (x.continuationItemRenderer) return 'more';
    var c = x.richItemRenderer.content;
    return c.adSlotRenderer ? 'AD' : c.videoRenderer.videoId;
  });
}
function reelSequence() {
  return { responseContext: {}, entries: [
    { command: { reelWatchEndpoint: { videoId: 's1' } } },
    { command: { reelWatchEndpoint: { videoId: 'ad', adClientParams: { isAd: true } } } },
    { command: { reelWatchEndpoint: { videoId: 's2', adClientParams: { isAd: false } } } }
  ] };
}

// ------------------------------------------------------------------ set-constant / abort
test('set-constant: existing nested path, value names, writes ignored', function () {
  var win = fakeWin('x.com');
  win.ads = { config: { enabled: true, other: 1 } };
  run(win, 'set-constant', ['ads.config.enabled', 'false']);
  assert.equal(win.ads.config.enabled, false);
  win.ads.config.enabled = true;
  assert.equal(win.ads.config.enabled, false, 'site write ignored');
  assert.equal(win.ads.config.other, 1, 'siblings untouched');
  run(win, 'set-constant', ['a', 'noopFunc']);
  assert.equal(typeof win.a, 'function');
  run(win, 'set-constant', ['b', 'emptyArr']);
  assert.ok(Array.isArray(win.b));
  run(win, 'set-constant', ['c', '42']);
  assert.equal(win.c, 42);
  run(win, 'set-constant', ['d', 'trueFunc']);
  assert.equal(win.d(), true);
  run(win, 'set-constant', ['e', 'something weird']);
  assert.notOk('e' in win, 'unknown value name: nothing defined');
});

test('set-constant: late-defined and replaced parents (ytcfg pattern), several leaves under one parent', function () {
  var win = fakeWin('www.youtube.com');
  run(win, 'set-constant', ['ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch', 'false']);
  run(win, 'set-constant', ['ytcfg.data_.EXPERIMENT_FLAGS.other_flag', 'true']);
  assert.equal(win.ytcfg, undefined, 'nothing created up front');
  win.ytcfg = win.ytcfg || {};
  win.ytcfg.data_ = win.ytcfg.data_ || {};
  win.ytcfg.data_.EXPERIMENT_FLAGS = { web_streaming_watch: true, keep: 'x' };
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, false);
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.other_flag, true);
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.keep, 'x');
  win.ytcfg.data_.EXPERIMENT_FLAGS = { web_streaming_watch: true };
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, false, 'replaced object trapped again');
  win.ytcfg = { data_: { EXPERIMENT_FLAGS: { web_streaming_watch: 1 } } };
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, false, 'whole chain replaced');
});

test('set-constant: a locked property is left alone (no throw)', function () {
  var win = fakeWin('x.com');
  Object.defineProperty(win, 'locked', { value: 5, writable: false, configurable: false });
  run(win, 'set-constant', ['locked', '0']);
  assert.equal(win.locked, 5);
});

test('abort-on-property-read / -write throw only on access', function () {
  var win = fakeWin('x.com');
  win.ReferenceError = ReferenceError;
  run(win, 'abort-on-property-read', ['detector.check']);
  win.detector = {};
  assert.throws(function () { return win.detector.check; });
  run(win, 'abort-on-property-write', ['adblockFlag']);
  assert.equal(win.adblockFlag, undefined);
  assert.throws(function () { win.adblockFlag = true; });
});

// ------------------------------------------------------------------ json-prune
test('json-prune: JSON.parse of a player response loses ad keys, keeps videoDetails / streamingData', function () {
  var win = fakeWin();
  run(win, 'json-prune', ['adPlacements adSlots playerAds playerResponse.adPlacements [].playerResponse.adPlacements']);
  assertPlayerClean(win.JSON.parse(PLAYER));
  var wrapped = win.JSON.parse(JSON.stringify({ playerResponse: player() }));
  assert.equal(wrapped.playerResponse.adPlacements, undefined, 'playerResponse.adPlacements');
  assert.ok(wrapped.playerResponse.adSlots, 'not listed, kept');
  var arr = win.JSON.parse(JSON.stringify([{ page: 'watch' }, { playerResponse: player() }]));
  assert.equal(arr[1].playerResponse.adPlacements, undefined, '[] at the root');
  assert.equal(win.JSON.parse('5'), 5);
  assert.equal(win.JSON.parse('"s"'), 's');
  assert.equal(JSON.parse(PLAYER).adPlacements.length, 2, 'the real JSON is untouched');
});

test('json-prune: required paths, [-] element removal, .. deep paths', function () {
  var win = fakeWin();
  var paths = '..contents.[-].richItemRenderer.content.adSlotRenderer ..continuationItems.[-].richItemRenderer.content.adSlotRenderer ..entries.[-].command.reelWatchEndpoint.adClientParams.isAd';
  run(win, 'json-prune', [paths, 'responseContext']);
  assert.deepEqual(feedIds(win.JSON.parse(JSON.stringify(feed()))), ['a', 'b', 'more', 'c']);
  var noCtx = feed();
  delete noCtx.responseContext;
  assert.deepEqual(feedIds(win.JSON.parse(JSON.stringify(noCtx))), ['a', 'AD', 'b', 'more', 'AD', 'c'], 'required path missing: untouched');
  var reels = win.JSON.parse(JSON.stringify(reelSequence()));
  assert.deepEqual(reels.entries.map(function (e) { return e.command.reelWatchEndpoint.videoId; }), ['s1', 's2'], 'isAd:false stays');
});

test('json-prune: Response.prototype.json is pruned too', function () {
  var win = fakeWin();
  run(win, 'json-prune', ['adPlacements playerAds adSlots']);
  return new win.Response(PLAYER).json().then(function (o) { assertPlayerClean(o); });
});

test('makePruner: [] over object values, cycles and a non-configurable key do not throw', function () {
  var p = L.makePruner('a.[].x ..y');
  var o = { a: { k1: { x: 1, z: 1 }, k2: { x: 2 } }, n: { y: 1, m: {} } };
  o.n.m.back = o;
  assert.equal(p(o), 3);
  assert.deepEqual(o.a, { k1: { z: 1 }, k2: {} });
  var locked = {};
  Object.defineProperty(locked, 'y', { value: 1, configurable: false, enumerable: true });
  assert.equal(p({ list: [locked] }), 0);
  assert.ok(L.makePruner('').empty);
});

test('prune-on-assign: ytInitialPlayerResponse assigned later (and present already) is pruned', function () {
  var win = fakeWin();
  run(win, 'prune-on-assign', ['ytInitialPlayerResponse', 'adPlacements adSlots playerAds']);
  win.ytInitialPlayerResponse = player();
  assertPlayerClean(win.ytInitialPlayerResponse);
  var win2 = fakeWin();
  win2.ytInitialData = feed();
  run(win2, 'prune-on-assign', ['ytInitialData', '..contents.[-].richItemRenderer.content.adSlotRenderer']);
  assert.deepEqual(feedIds(win2.ytInitialData), ['a', 'b', 'more', 'AD', 'c']);
});

// ------------------------------------------------------------------ fetch / XHR
test('json-prune-fetch-response: matching URL pruned, status / headers / url / type kept', function () {
  var win = fakeWin('www.youtube.com', { bodies: { '/youtubei/v1/player?key=1': PLAYER, '/youtubei/v1/log_event': PLAYER } });
  var origFetch = win.fetch;
  run(win, 'json-prune-fetch-response', ['adPlacements adSlots playerAds', '/\\/youtubei\\/v1\\/player(\\?|$)/']);
  assert.ok(win.fetch !== origFetch, 'fetch wrapped');
  return win.fetch('/youtubei/v1/player?key=1').then(function (r) {
    assert.equal(r.status, 203);
    assert.equal(r.statusText, 'Odd');
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('content-length'), null, 'length dropped (body changed)');
    assert.equal(r.url, 'https://www.youtube.com/youtubei/v1/player?key=1');
    assert.equal(r.type, 'basic');
    return r.json();
  }).then(function (o) {
    assertPlayerClean(o);
    return win.fetch({ url: '/youtubei/v1/log_event' });
  }).then(function (r) {
    assert.equal(r.headers.get('content-length'), '999', 'other URL: the original response');
    return r.json();
  }).then(function (o) {
    assert.equal(o.adPlacements.length, 2);
  });
});

test('json-prune-fetch-response: non-JSON or ad-free bodies come back as the original response', function () {
  var win = fakeWin('www.youtube.com', { bodies: { '/youtubei/v1/next': 'not json', '/youtubei/v1/browse': '{"a":1}' } });
  run(win, 'json-prune-fetch-response', ['adPlacements', '/youtubei/']);
  return win.fetch('/youtubei/v1/next').then(function (r) {
    assert.equal(r.headers.get('content-length'), '999');
    return r.text();
  }).then(function (t) {
    assert.equal(t, 'not json');
    return win.fetch('/youtubei/v1/browse');
  }).then(function (r) {
    assert.equal(r.headers.get('content-length'), '999');
  });
});

test('json-prune-xhr-response: only matching requests; text and json response types; reused xhr', function () {
  var bodies = { '/youtubei/v1/player': PLAYER, '/other': PLAYER };
  var win = fakeWin('www.youtube.com', { bodies: bodies });
  run(win, 'json-prune-xhr-response', ['adPlacements adSlots playerAds', '/youtubei/v1/player']);
  var x = new win.XMLHttpRequest();
  assert.equal(x.responseText, '', 'before open');
  x.open('POST', '/youtubei/v1/player');
  assert.equal(x.responseText, '', 'not done yet');
  x.send();
  assertPlayerClean(JSON.parse(x.responseText));
  assert.equal(x.response, x.responseText, 'response equals responseText');
  x.open('GET', '/other');
  x.send();
  assert.equal(JSON.parse(x.responseText).adPlacements.length, 2, 'reused for another URL: untouched');
  var j = new win.XMLHttpRequest();
  j.responseType = 'json';
  j.open('POST', '/youtubei/v1/player');
  j.send();
  assertPlayerClean(j.response);
  assert.throws(function () { return j.responseText; }, 'native error kept for responseText of a json request');
});

// ------------------------------------------------------------------ needle pre-check (no work on ad-free payloads)
/** A second copy of lib.js whose captured JSON.parse counts its calls, so skipped parses show. */
function countingLib() {
  var orig = JSON.parse, c = { parses: 0 };
  JSON.parse = function (s, r) { c.parses++; return orig.call(JSON, s, r); };
  try { load('src/scriptlets/lib.js'); c.lib = asScriptlets; } finally { JSON.parse = orig; asScriptlets = L; }
  c.run = function (win, name, args) { c.lib.scriptlets[name](win, args || [], log); };
  return c;
}
/** obj behind a Proxy that records every look at it (the pruner always looks at the root); the
 * promise machinery's look for a .then is not counted. */
function watched(obj, touches) {
  function note(n) {
    return function (target, key) {
      if (!(n === 'get' && key === 'then')) touches.push(n);
      return Reflect[n].apply(Reflect, arguments);
    };
  }
  return new Proxy(obj, { get: note('get'), has: note('has'), ownKeys: note('ownKeys'), deleteProperty: note('deleteProperty'), getOwnPropertyDescriptor: note('getOwnPropertyDescriptor') });
}
var FEED_PATHS = '..contents.[-].richItemRenderer.content.adSlotRenderer ..entries.[-].command.reelWatchEndpoint.adClientParams.isAd';

test('makePruner.mayMatch: true only when the text has the last word of some path', function () {
  var p = L.makePruner('adPlacements playerResponse.adSlots [].playerResponse.playerAds ' + FEED_PATHS + ' ..contents.[-].searchPyvRenderer');
  assert.equal(typeof p.mayMatch, 'function');
  ['"adPlacements":[]', '{"adSlots":1}', 'playerAds', 'adSlotRenderer', 'searchPyvRenderer', '"isAd":true'].forEach(function (t) {
    assert.ok(p.mayMatch(t), t);
  });
  ['{"videoDetails":{}}', 'playerResponse', 'reelWatchEndpoint adClientParams', ''].forEach(function (t) {
    assert.notOk(p.mayMatch(t), t);
  });
  assert.ok(L.makePruner('[-].[]').mayMatch('{"x":1}'), 'a path with no key in it: every text is a candidate');
});

test('makePruner(obj, text): a deep path walks only when its own needle is in the text', function () {
  var p = L.makePruner('adPlacements ..entries.[-].command.reelWatchEndpoint.adClientParams.isAd');
  var touches = [];
  var inner = watched({ entries: [{ command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } }] }, touches);
  var o = { adPlacements: [1], deep: inner };
  assert.equal(p(o, '{"adPlacements":[1]}'), 1, 'plain key removed');
  assert.deepEqual(touches, [], 'no isAd in the text: the deep path never walked');
  var o2 = { adPlacements: [1], deep: { entries: [{ command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } }] } };
  assert.equal(p(o2, '{"adPlacements":[1],"isAd":true}'), 2, 'needle present: walked');
  assert.equal(p({ deep: { entries: [{ command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } }] } }), 1, 'no text: every path, as before');
});

test('json-prune: JSON.parse of a needle-free string is not walked; with a needle it is pruned as before', function () {
  var win = fakeWin();
  var touches = [];
  var nativeParse = win.JSON.parse;
  win.JSON.parse = function parse(s, r) { return watched(nativeParse(s, r), touches); };
  run(win, 'json-prune', [FEED_PATHS + ' adPlacements', 'responseContext']);
  var o = win.JSON.parse('{"responseContext":{},"contents":[{"videoRenderer":{"videoId":"a"}}]}');
  assert.deepEqual(touches, [], 'no needle: the parsed object is returned as is, never looked at');
  assert.equal(o.contents[0].videoRenderer.videoId, 'a');
  touches.length = 0;
  var f = win.JSON.parse(JSON.stringify(feed()));
  assert.ok(touches.length > 0, 'needle present: pruned');
  assert.deepEqual(feedIds(f), ['a', 'b', 'more', 'AD', 'c'], 'same result as without the pre-check');
  var withReviver = win.JSON.parse('{"responseContext":{}}', function (k, v) { if (k === '') v.adPlacements = [1]; return v; });
  assert.equal(withReviver.adPlacements, undefined, 'a reviver can add keys the text lacks: still pruned');
});

test('json-prune-fetch-response: needle-free body not parsed, same Response object; needle body pruned', function () {
  var c = countingLib();
  var win = fakeWin('www.youtube.com', { bodies: { '/youtubei/v1/next': '{"responseContext":{},"contents":[]}', '/youtubei/v1/player': PLAYER } });
  var sent = [];
  var origFetch = win.fetch;
  win.fetch = function fetch(u) { return origFetch(u).then(function (r) { sent.push(r); return r; }); };
  c.run(win, 'json-prune-fetch-response', ['adPlacements adSlots playerAds ' + FEED_PATHS, '/youtubei/']);
  return win.fetch('/youtubei/v1/next').then(function (r) {
    assert.ok(r === sent[0], 'the original Response object');
    assert.equal(c.parses, 0, 'no JSON.parse of an ad-free body');
    return win.fetch('/youtubei/v1/player');
  }).then(function (r) {
    assert.ok(r !== sent[1], 'pruned copy');
    assert.equal(c.parses, 1);
    return r.text();
  }).then(function (t) { assertPlayerClean(JSON.parse(t)); });
});

test('json-prune: Response.json of a Response json-prune-fetch-response already pruned is not pruned again', function () {
  var win = fakeWin('www.youtube.com', { bodies: { '/youtubei/v1/player': PLAYER } });
  var touches = [];
  var nativeJson = win.Response.prototype.json;
  win.Response.prototype.json = function json() { return nativeJson.call(this).then(function (o) { return watched(o, touches); }); };
  run(win, 'json-prune', ['adPlacements adSlots playerAds']);
  run(win, 'json-prune-fetch-response', ['adPlacements adSlots playerAds', '/youtubei/']);
  return win.fetch('/youtubei/v1/player').then(function (r) { return r.json(); }).then(function (o) {
    assert.deepEqual(touches, [], 'already pruned: .json() result not walked again');
    assertPlayerClean(o);
    touches.length = 0;
    return new win.Response(PLAYER).json();
  }).then(function (o) {
    assert.ok(touches.length > 0, 'any other Response: pruned');
    assertPlayerClean(o);
  });
});

test('json-prune-xhr-response: needle-free string body not parsed; needle body pruned', function () {
  var c = countingLib();
  var win = fakeWin('www.youtube.com', { bodies: { '/youtubei/v1/next': '{"responseContext":{},"contents":[]}', '/youtubei/v1/player': PLAYER } });
  c.run(win, 'json-prune-xhr-response', ['adPlacements adSlots playerAds ' + FEED_PATHS, '/youtubei/']);
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/next');
  x.send();
  assert.equal(x.responseText, '{"responseContext":{},"contents":[]}');
  assert.equal(x.response, x.responseText);
  assert.equal(c.parses, 0, 'no JSON.parse of an ad-free body');
  x.open('POST', '/youtubei/v1/player');
  x.send();
  assertPlayerClean(JSON.parse(x.responseText));
  assert.equal(c.parses, 1);
});

test('prevent-fetch: matching URL answered locally with an empty 200, others sent', function () {
  var win = fakeWin('x.com');
  run(win, 'prevent-fetch', ['/pagead/']);
  return win.fetch('/pagead/ping?x').then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.url, '/pagead/ping?x');
    assert.deepEqual(win.fetched, []);
    return r.text();
  }).then(function (t) {
    assert.equal(t, '');
    return win.fetch('/api/ok');
  }).then(function () {
    assert.deepEqual(win.fetched, ['/api/ok']);
  });
});

// ------------------------------------------------------------------ timers / promises
test('prevent-setTimeout: needle and delay', function () {
  var win = fakeWin('x.com');
  var base = win.setTimeout;
  run(win, 'prevent-setTimeout', ['adblock', '']);
  run(win, 'prevent-setTimeout', ['', '17000']);
  run(win, 'prevent-setTimeout', ['', '']);
  var ran = [];
  win.setTimeout(function () { ran.push('detector adblock'); }, 10);
  win.setTimeout(function () { ran.push('slow'); }, 17000);
  win.setTimeout(function () { ran.push('fine'); }, 50);
  win.timers.forEach(function (t) { t.fn(); });
  assert.deepEqual(ran, ['fine']);
  assert.equal(win.timers.length, 3, 'still scheduled (as no-ops), ids stay valid');
  assert.ok(win.setTimeout !== base);
});

test('adjust-setTimeout: matching source and delay shortened; others untouched; looks native', function () {
  var nativeTs = Function.prototype.toString;
  var FP = { toString: nativeTs };
  var win = fakeWin('www.youtube.com');
  win.Function = { prototype: FP };
  var base = win.setTimeout;
  run(win, 'adjust-setTimeout', ['[native code]', '17000', '0.001']);
  assert.ok(win.setTimeout !== base, 'wrapped');
  var bound = function () {}.bind(null);
  win.setTimeout(bound, 17000);
  assert.equal(win.timers[0].ms, 17, '17000 * 0.001');
  assert.ok(win.timers[0].fn === bound, 'same callback');
  win.setTimeout(bound, 5000);
  assert.equal(win.timers[1].ms, 5000, 'other delay untouched');
  win.setTimeout(function () { return 'page code'; }, 17000);
  assert.equal(win.timers[2].ms, 17000, 'non-matching source untouched');
  win.setTimeout('x()', 17000);
  assert.equal(win.timers[3].ms, 17000, 'string callback that does not match');
  assert.equal(win.setTimeout.toString(), nativeTs.call(base), 'own toString shows the original');
  assert.equal(String(win.setTimeout), nativeTs.call(base), 'String() too');
  assert.ok(FP.toString === nativeTs, "the realm's Function.prototype.toString is not patched");
  assert.equal(win.setTimeout.name, base.name);
  // any delay, default factor 0.05, string callback, clamping
  var w2 = fakeWin('x.com');
  run(w2, 'adjust-setTimeout', ['tick', '']);
  w2.setTimeout('tick()', 1000);
  w2.setTimeout(function tick() {}, 200);
  assert.deepEqual(w2.timers.map(function (t) { return t.ms; }), [50, 10]);
  var w3 = fakeWin('x.com');
  run(w3, 'adjust-setTimeout', ['', '100', '500']);
  run(w3, 'adjust-setTimeout', ['', '7', '0']);
  w3.setTimeout(function () {}, 100);
  w3.setTimeout(function () {}, 7);
  assert.deepEqual(w3.timers.map(function (t) { return t.ms; }), [5000, 0.007], 'factor clamped to 50 / 0.001');
  var w4 = fakeWin('x.com');
  var b4 = w4.setTimeout;
  run(w4, 'adjust-setTimeout', ['x', 'abc']);
  assert.ok(w4.setTimeout === b4, 'bad delay: not wrapped');
  assert.notOk(L.scriptlets['adjust-setTimeout'].frames, 'not re-applied to child frames');
});

/** A second copy of lib.js whose captured Function.prototype.toString counts its calls. */
function toStringCountingLib() {
  var FPT = Function.prototype, orig = FPT.toString, c = { calls: 0 };
  FPT.toString = function toString() { c.calls++; return orig.call(this); };
  try { load('src/scriptlets/lib.js'); c.lib = asScriptlets; } finally { FPT.toString = orig; asScriptlets = L; }
  return c;
}

test('adjust-setTimeout: other delays never read the callback source (no toString of any kind)', function () {
  var c = toStringCountingLib();
  var win = fakeWin('www.youtube.com');
  c.lib.scriptlets['adjust-setTimeout'](win, ['[native code]', '17000', '0.001'], log);
  var own = 0;
  var cb = function () {};
  cb.toString = function () { own++; return 'function () { [native code] }'; };
  var objCb = { toString: function () { own++; return '[native code]'; } };
  var bound = function () {}.bind(null);
  [0, 16999, 17001, 5000, undefined].forEach(function (ms) {
    win.setTimeout(cb, ms);
    win.setTimeout(objCb, ms);
    win.setTimeout(bound, ms);
  });
  assert.equal(c.calls, 0, 'Function.prototype.toString not called for other delays');
  assert.equal(own, 0, "the callback's own toString not called");
  assert.ok(win.timers.every(function (t) { return t.ms !== 17; }), 'nothing shortened');
  win.setTimeout(bound, 17000);
  assert.equal(win.timers[win.timers.length - 1].ms, 17, '17000 native: shortened');
  assert.equal(c.calls, 1, 'source read once, only for the matching delay');
  win.setTimeout(function () { return 'page'; }, 17000);
  assert.equal(win.timers[win.timers.length - 1].ms, 17000, '17000 page code: untouched');
});

test('rules: adjust-setTimeout for the 17 s fake-buffering delay on youtube.com', function () {
  var hits = R.pick(RULES, 'www.youtube.com').filter(function (s) { return s[0] === 'adjust-setTimeout'; });
  assert.deepEqual(hits, [['adjust-setTimeout', '[native code]', '17000', '0.001']]);
  assert.equal(R.pick(RULES, 'example.com').length, 0);
});

test('prevent-promise-then-callback: the onAbnormalityDetected callback becomes a no-op', function () {
  var win = fakeWin();
  run(win, 'prevent-promise-then-callback', ['onAbnormalityDetected']);
  var hits = [];
  var P = win.Promise;
  var report = function (x) { hits.push('report ' + x); /* this.onAbnormalityDetected() */ };
  var fine = function (x) { hits.push('fine ' + x); };
  P.resolve(1).then(report);
  P.resolve(2).then(fine);
  P.reject(3).then(null, function onAbnormalityDetected(e) { hits.push('rejected ' + e); });
  return flush().then(function () {
    assert.deepEqual(hits, ['fine 2']);
    assert.equal(Promise.prototype.then.toString().indexOf('native') !== -1, true, 'global Promise untouched');
  });
});

// ------------------------------------------------------------------ native look and frames
test('wrapped functions keep name / length and get a non-enumerable own toString; Function.prototype.toString untouched', function () {
  var nativeTs = Function.prototype.toString;
  var FP = { toString: nativeTs };
  var win = fakeWin();
  win.Function = { prototype: FP };
  var orig = win.JSON.parse;
  var src = nativeTs.call(orig);
  run(win, 'json-prune', ['adPlacements']);
  run(win, 'json-prune', ['adSlots']); // wrapped twice: still the first original's source
  assert.ok(win.JSON.parse !== orig);
  assert.equal(win.JSON.parse.name, 'parse');
  assert.equal(win.JSON.parse.length, 2);
  assert.equal(win.JSON.parse.toString(), src);
  assert.equal(win.JSON.parse + '', src);
  var d = Object.getOwnPropertyDescriptor(win.JSON.parse, 'toString');
  assert.ok(d && d.enumerable === false, 'own, non-enumerable');
  assert.deepEqual(Object.keys(win.JSON.parse), [], 'nothing enumerable added');
  assert.includes(win.JSON.parse.toString.toString(), '[native code]', 'the own toString looks native itself');
  assert.ok(FP.toString === nativeTs, 'no realm-wide toString patch');
  assert.ok(Function.prototype.toString === nativeTs, 'global Function.prototype.toString untouched');
  var parsed = win.JSON.parse(PLAYER);
  assert.equal(parsed.adPlacements, undefined, 'still prunes');
  assert.equal(parsed.adSlots, undefined, 'second wrapper too');
});

test('runner: frame scriptlets reach a same-origin about:blank child through contentWindow', function () {
  var child = fakeWin('');
  child.document = { domain: 'www.youtube.com' };
  var IFP = {};
  Object.defineProperty(IFP, 'contentWindow', { get: function () { return child; }, configurable: true, enumerable: true });
  var crossOrigin = { get document() { throw new Error('SecurityError'); } };
  var IFP2 = {};
  Object.defineProperty(IFP2, 'contentWindow', { get: function () { return crossOrigin; }, configurable: true });
  var win = fakeWin();
  win.HTMLIFrameElement = { prototype: IFP };
  var table = { rules: [{ hosts: ['youtube.com'], scriptlets: [['json-prune', 'adPlacements'], ['set-constant', 'flag', 'true']] }] };
  var ran = R.run(win, L, table, log);
  assert.deepEqual(ran, ['json-prune', 'set-constant']);
  var childParse = child.JSON.parse;
  var iframe = Object.create(IFP);
  assert.ok(iframe.contentWindow === child);
  assert.ok(child.JSON.parse !== childParse, "child's JSON.parse wrapped on first access");
  assert.equal(child.JSON.parse(PLAYER).adPlacements, undefined);
  assert.equal(child.flag, undefined, 'only the frame scriptlets are re-applied');
  var again = child.JSON.parse;
  void iframe.contentWindow;
  assert.ok(child.JSON.parse === again, 'patched once per document');
  win.HTMLIFrameElement = { prototype: IFP2 };
  R.run(win, L, table, log);
  assert.ok(Object.create(IFP2).contentWindow === crossOrigin, 'cross-origin frame: getter still works');
});

// ------------------------------------------------------------------ runner host matching
test('runner: host and parent domains match; look-alikes do not', function () {
  var table = { rules: [{ hosts: ['youtube.com'], scriptlets: [['set-constant', 'x', 'true']] }, { hosts: ['other.org'], scriptlets: [['set-constant', 'y', 'true']] }] };
  ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'WWW.YOUTUBE.COM.'].forEach(function (h) {
    assert.deepEqual(R.pick(table, R.hostOf({ location: { hostname: h } })).map(function (s) { return s[1]; }), ['x'], h);
  });
  ['notyoutube.com', 'youtube.com.evil.net', 'youtube.co', ''].forEach(function (h) {
    assert.deepEqual(R.pick(table, R.hostOf({ location: { hostname: h } })), [], h);
  });
  assert.equal(R.hostOf({ location: { hostname: '' }, document: { domain: 'www.youtube.com' } }), 'www.youtube.com', 'about:blank: document.domain');
  assert.equal(R.hostOf({ location: { hostname: '' }, document: {}, origin: 'https://m.youtube.com' }), 'm.youtube.com', 'self.origin fallback');
  var win = fakeWin('notyoutube.com');
  assert.deepEqual(R.run(win, L, table, log), []);
  assert.equal(win.x, undefined);
  assert.deepEqual(R.run(fakeWin('x.com'), L, { rules: [{ hosts: ['x.com'], scriptlets: [['no-such-scriptlet'], ['set-constant', 'x', 'true']] }] }, log), ['set-constant'], 'unknown names skipped');
  assert.deepEqual(R.pick(null, 'x.com'), []);
});

// ------------------------------------------------------------------ the real rules
test('rules/scriptlets.json: every scriptlet exists, hosts are plain domains', function () {
  assert.equal(RULES.version, 1);
  RULES.rules.forEach(function (r) {
    r.hosts.forEach(function (h) { assert.ok(/^[a-z0-9.-]+\.[a-z]+$/.test(h), h); });
    r.scriptlets.forEach(function (s) { assert.equal(typeof L.scriptlets[s[0]], 'function', s[0]); });
  });
});

test('YouTube rules end to end: initial globals, JSON.parse, fetch, XHR, Shorts; no ytcfg flag, no abnormality hook', function () {
  var bodies = {
    '/youtubei/v1/player?prettyPrint=false': PLAYER,
    '/youtubei/v1/browse?prettyPrint=false': JSON.stringify(feed()),
    '/youtubei/v1/reel/reel_watch_sequence?x=1': JSON.stringify(reelSequence()),
    '/youtubei/v1/player/heartbeat': PLAYER
  };
  var win = fakeWin('www.youtube.com', { bodies: bodies });
  var ran = R.run(win, L, RULES, log);
  assert.ok(ran.indexOf('json-prune-fetch-response') !== -1 && ran.indexOf('youtube-ad-skip') !== -1, ran.join());
  win.ytInitialPlayerResponse = player();
  assertPlayerClean(win.ytInitialPlayerResponse, 'ytInitialPlayerResponse');
  win.ytInitialData = feed();
  assert.deepEqual(feedIds(win.ytInitialData), ['a', 'b', 'more', 'c'], 'ytInitialData');
  assertPlayerClean(win.JSON.parse(PLAYER), 'JSON.parse');
  assert.deepEqual(feedIds(win.JSON.parse(JSON.stringify(feed()))), ['a', 'AD', 'b', 'more', 'AD', 'c'], 'JSON.parse: feed items no longer pruned (youtube.css hides them)');
  win.ytcfg = { data_: {} };
  win.ytcfg.data_.EXPERIMENT_FLAGS = { web_streaming_watch: true };
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, true, 'web_streaming_watch left alone');
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/player?prettyPrint=false');
  x.send();
  assertPlayerClean(JSON.parse(x.responseText), 'XHR');
  var hits = [];
  win.Promise.resolve().then(function onAbnormalityDetected() { hits.push('a'); });
  return win.fetch('/youtubei/v1/player?prettyPrint=false').then(function (r) { return r.text(); }).then(function (t) {
    assertPlayerClean(JSON.parse(t), 'fetch /player');
    return win.fetch('/youtubei/v1/browse?prettyPrint=false');
  }).then(function (r) { return r.text(); }).then(function (t) {
    assert.deepEqual(feedIds(JSON.parse(t)), ['a', 'AD', 'b', 'more', 'AD', 'c'], 'fetch /browse not pruned');
    return win.fetch('/youtubei/v1/reel/reel_watch_sequence?x=1');
  }).then(function (r) { return r.json(); }).then(function (o) {
    assert.equal(o.entries.length, 2, 'Shorts ad entry removed');
    return win.fetch('/youtubei/v1/player/heartbeat');
  }).then(function (r) {
    assert.equal(r.headers.get('content-length'), '999', 'heartbeat not matched by the URL pattern');
    assert.deepEqual(hits, ['a'], 'then() callbacks run as written');
  });
});

test('YouTube rules: no Promise.prototype.then and no Function.prototype.toString patch', function () {
  var nativeTs = Function.prototype.toString, nativeThen = Promise.prototype.then;
  var FP = { toString: nativeTs };
  var win = fakeWin('www.youtube.com');
  win.Function = { prototype: FP };
  var thenBefore = win.Promise.prototype.then;
  var ran = R.run(win, L, RULES, log);
  assert.equal(ran.indexOf('prevent-promise-then-callback'), -1, ran.join());
  assert.equal(ran.indexOf('set-constant'), -1, ran.join());
  assert.notOk(Object.prototype.hasOwnProperty.call(win.Promise.prototype, 'then'), 'no then on the page Promise');
  assert.ok(win.Promise.prototype.then === thenBefore && thenBefore === nativeThen, 'then untouched');
  assert.ok(FP.toString === nativeTs, "the page realm's Function.prototype.toString untouched");
  assert.ok(Function.prototype.toString === nativeTs && Promise.prototype.then === nativeThen, 'globals untouched');
  var names = R.pick(RULES, 'www.youtube.com').map(function (s) { return s.join(' '); });
  names.forEach(function (n) {
    assert.notIncludes(n, 'onAbnormalityDetected');
    assert.notIncludes(n, 'web_streaming_watch');
    assert.notIncludes(n, 'responseContext');
  });
  assert.equal(R.pick(RULES, 'www.youtube.com').filter(function (s) { return s[0] === 'json-prune'; }).length, 1, 'only the player-keys json-prune');
});

test('YouTube rules: fetch / XHR pruning applies to /youtubei/v1/player, not to /youtubei/v1/browse', function () {
  var c = countingLib();
  var bodies = {
    '/youtubei/v1/player?prettyPrint=false': PLAYER,
    '/youtubei/v1/browse?prettyPrint=false': PLAYER,
    '/youtubei/v1/next?prettyPrint=false': PLAYER,
    '/youtubei/v1/search?prettyPrint=false': PLAYER,
    '/youtubei/v1/get_watch?prettyPrint=false': PLAYER,
    '/youtubei/v1/navigation/resolve_url?prettyPrint=false': PLAYER
  };
  var win = fakeWin('www.youtube.com', { bodies: bodies });
  R.run(win, c.lib, RULES, log);
  c.parses = 0; // setup: edit-request-body parses its JSON edit values once
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/browse?prettyPrint=false');
  x.send();
  assert.equal(x.responseText, PLAYER, 'XHR /browse untouched');
  assert.equal(c.parses, 0, 'XHR /browse body not parsed');
  x.open('POST', '/youtubei/v1/player?prettyPrint=false');
  x.send();
  assertPlayerClean(JSON.parse(x.responseText), 'XHR /player');
  var parses = c.parses;
  var unpruned = ['browse', 'next', 'search'];
  return unpruned.reduce(function (p, ep) {
    return p.then(function () { return win.fetch('/youtubei/v1/' + ep + '?prettyPrint=false'); }).then(function (r) {
      assert.equal(r.headers.get('content-length'), '999', ep + ': the original response');
      assert.equal(c.parses, parses, ep + ': body not read or parsed');
    });
  }, Promise.resolve()).then(function () {
    return ['player', 'get_watch', 'navigation/resolve_url'].reduce(function (p, ep) {
      return p.then(function () { return win.fetch('/youtubei/v1/' + ep + '?prettyPrint=false'); }).then(function (r) {
        assert.equal(r.headers.get('content-length'), null, ep + ': pruned copy');
        return r.text();
      }).then(function (t) { assertPlayerClean(JSON.parse(t), ep); });
    }, Promise.resolve());
  });
});

function resolveUrlResponse() {
  return {
    responseContext: { visitorData: 'v' },
    endpoint: {
      commandMetadata: { webCommandMetadata: { url: '/watch?v=jNQXAC9IVRw' } },
      watchEndpoint: { videoId: 'jNQXAC9IVRw', unserializedPrefetchData: { playerResponse: player() } }
    }
  };
}
function assertResolveUrlClean(o, msg) {
  assert.equal(o.responseContext.visitorData, 'v', msg + ' responseContext kept');
  assert.equal(o.endpoint.commandMetadata.webCommandMetadata.url, '/watch?v=jNQXAC9IVRw', msg + ' commandMetadata kept');
  assert.equal(o.endpoint.watchEndpoint.videoId, 'jNQXAC9IVRw', msg + ' watchEndpoint kept');
  assertPlayerClean(o.endpoint.watchEndpoint.unserializedPrefetchData.playerResponse, msg + ' prefetch playerResponse');
}

test('YouTube rules: navigation/resolve_url prefetch playerResponse (endpoint.watchEndpoint.unserializedPrefetchData.playerResponse) loses playerAds / adPlacements / adSlots, fetch and XHR', function () {
  var body = JSON.stringify(resolveUrlResponse());
  var url = '/youtubei/v1/navigation/resolve_url?prettyPrint=false';
  var bodies = {};
  bodies[url] = body;
  var win = fakeWin('www.youtube.com', { bodies: bodies });
  R.run(win, L, RULES, log);
  var x = new win.XMLHttpRequest();
  x.open('POST', url);
  x.send();
  assertResolveUrlClean(JSON.parse(x.responseText), 'XHR');
  return win.fetch(url).then(function (r) { return r.json(); }).then(function (o) {
    assertResolveUrlClean(o, 'fetch');
  });
});

test('YouTube rules: /youtubei/v1/player_xyz and /youtubei/v1/playerX are not matched by the player URL pattern', function () {
  var c = countingLib();
  var bodies = { '/youtubei/v1/player_xyz?prettyPrint=false': PLAYER, '/youtubei/v1/playerX': PLAYER };
  var win = fakeWin('www.youtube.com', { bodies: bodies });
  R.run(win, c.lib, RULES, log);
  c.parses = 0; // setup: edit-request-body parses its JSON edit values once
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/player_xyz?prettyPrint=false');
  x.send();
  assert.equal(x.responseText, PLAYER, 'XHR /player_xyz untouched');
  assert.equal(c.parses, 0, 'XHR /player_xyz body not parsed');
  return ['player_xyz?prettyPrint=false', 'playerX'].reduce(function (p, ep) {
    return p.then(function () { return win.fetch('/youtubei/v1/' + ep); }).then(function (r) {
      assert.equal(r.headers.get('content-length'), '999', ep + ': the original response');
      assert.equal(c.parses, 0, ep + ': body not read or parsed');
    });
  }, Promise.resolve());
});

function ruleArgs(host, name) {
  return R.pick(RULES, host).filter(function (s) { return s[0] === name; });
}

test('YouTube rules: a Shorts batch read with JSON.parse loses its isAd entries; JSON.parse stays a needle check plus key lookups', function () {
  var win = fakeWin('m.youtube.com');
  R.run(win, L, RULES, log);
  var reels = win.JSON.parse(JSON.stringify(reelSequence()));
  assert.deepEqual(reels.entries.map(function (e) { return e.command.reelWatchEndpoint.videoId; }), ['s1', 's2'], 'isAd:true removed, isAd:false stays');
  var nested = win.JSON.parse(JSON.stringify({ deep: reelSequence() }));
  assert.equal(nested.deep.entries.length, 3, 'only a top-level entries list (no deep walk on JSON.parse)');
  var jp = ruleArgs('m.youtube.com', 'json-prune');
  assert.equal(jp.length, 1);
  jp[0][1].split(' ').forEach(function (p) { assert.ok(p.indexOf('..') !== 0, 'plain path: ' + p); });
  var p = L.makePruner(jp[0][1]);
  assert.notOk(p.mayMatch('{"videoDetails":{},"entries":[{"command":{}}]}'), 'no needle word: not walked');
  assert.ok(p.mayMatch('{"entries":[{"isAd":true}]}'), 'isAd is a needle');
});

function getWatchBody() {
  var items = [
    { videoWithContextRenderer: { videoId: 'v1' } },
    { adSlotRenderer: { adSlotMetadata: {} } },
    { videoWithContextRenderer: { videoId: 'v2' } }
  ];
  return JSON.stringify([
    { playerResponse: player() },
    { response: { contents: { singleColumnWatchNextResults: { results: { results: { contents: [
      { itemSectionRenderer: { contents: items } },
      { slimVideoMetadataSectionRenderer: { contents: [{ adSlotRenderer: { keep: 'not an itemSectionRenderer list' } }] } }
    ] } } } } } }
  ]);
}
function watchNext(o) {
  var c = o[1].response.contents.singleColumnWatchNextResults.results.results.contents;
  return {
    ids: c[0].itemSectionRenderer.contents.map(function (x) { return x.adSlotRenderer ? 'AD' : x.videoWithContextRenderer.videoId; }),
    other: c[1].slimVideoMetadataSectionRenderer.contents.length
  };
}

test('m.youtube.com get_watch: adSlotRenderer items leave itemSectionRenderer.contents (fetch); www and other endpoints untouched', function () {
  var bodies = {
    '/youtubei/v1/get_watch?prettyPrint=false': getWatchBody(),
    '/youtubei/v1/next?prettyPrint=false': getWatchBody()
  };
  assert.equal(ruleArgs('www.youtube.com', 'json-prune-fetch-response').length, 1, 'www: only the shared fetch rule');
  assert.equal(ruleArgs('m.youtube.com', 'json-prune-fetch-response').length, 2, 'm: plus the get_watch item rule');
  var m = fakeWin('m.youtube.com', { bodies: bodies });
  var www = fakeWin('www.youtube.com', { bodies: bodies });
  R.run(m, L, RULES, log);
  R.run(www, L, RULES, log);
  return m.fetch('/youtubei/v1/get_watch?prettyPrint=false').then(function (r) { return r.json(); }).then(function (o) {
    assertPlayerClean(o[0].playerResponse, 'm get_watch');
    assert.deepEqual(watchNext(o), { ids: ['v1', 'v2'], other: 1 }, 'm get_watch: ad item gone, other lists kept');
    return m.fetch('/youtubei/v1/next?prettyPrint=false');
  }).then(function (r) { return r.json(); }).then(function (o) {
    assert.deepEqual(watchNext(o).ids, ['v1', 'AD', 'v2'], 'm /next: not matched by the URL pattern');
    return www.fetch('/youtubei/v1/get_watch?prettyPrint=false');
  }).then(function (r) { return r.json(); }).then(function (o) {
    assertPlayerClean(o[0].playerResponse, 'www get_watch');
    assert.deepEqual(watchNext(o).ids, ['v1', 'AD', 'v2'], 'www get_watch: items left to youtube.css');
  });
});

// ------------------------------------------------------------------ DOM scriptlets
function fakeEl(tag, attrs, classes) {
  var el = { tagName: tag, attrs: Object.assign({}, attrs || {}), cls: (classes || []).slice() };
  el.hasAttribute = function (a) { return a in el.attrs; };
  el.removeAttribute = function (a) { delete el.attrs[a]; };
  el.classList = {
    contains: function (c) { return el.cls.indexOf(c) !== -1; },
    remove: function (c) { el.cls = el.cls.filter(function (x) { return x !== c; }); },
    add: function (c) { if (el.cls.indexOf(c) === -1) el.cls.push(c); }
  };
  return el;
}
function fakeObserverClass(list) {
  return function MO(cb) {
    this.cb = cb; this.connected = false;
    this.observe = function (target, opts) { this.connected = true; this.target = target; this.opts = opts; };
    this.disconnect = function () { this.connected = false; };
    list.push(this);
  };
}

test('remove-attr / remove-class: run at once when loaded, throttled re-runs, observer gone after 10 s', function () {
  var els = [fakeEl('BODY', { style: 'overflow:hidden', 'data-x': '1' }, ['no-scroll', 'keep'])];
  var queries = [];
  var observers = [];
  var doc = {
    readyState: 'interactive', documentElement: {},
    addEventListener: function () {},
    querySelectorAll: function (sel) { queries.push(sel); return els; }
  };
  var win = fakeWin('x.com', { document: doc });
  win.MutationObserver = fakeObserverClass(observers);
  win.addEventListener = function () {};
  run(win, 'remove-attr', ['style|onclick', 'body']);
  run(win, 'remove-class', ['no-scroll']);
  assert.deepEqual(els[0].attrs, { 'data-x': '1' });
  assert.deepEqual(els[0].cls, ['keep']);
  assert.deepEqual(queries, ['body', '.no-scroll']);
  assert.equal(observers.length, 2);
  assert.deepEqual(observers[0].opts.attributeFilter, ['style', 'onclick']);
  els[0].attrs.style = 'x';
  observers[0].cb([]); observers[0].cb([]);
  var reruns = win.timers.filter(function (t) { return t.ms === 100; });
  assert.equal(reruns.length, 1, 'one pending re-run however many mutations');
  reruns[0].fn();
  assert.deepEqual(els[0].attrs, { 'data-x': '1' });
  win.timers.filter(function (t) { return t.ms === 10000; }).forEach(function (t) { t.fn(); });
  assert.notOk(observers[0].connected || observers[1].connected, 'disconnected');
  run(win, 'remove-attr', ['!bad']);
  assert.equal(observers.length, 2, 'invalid names: nothing set up');
});

test('youtube-ad-skip: ad-showing mutes, seeks to the end, clicks Skip; restores sound; leaves SSAP alone', function () {
  var listeners = {};
  var observers = [];
  var doc = { addEventListener: function (type, fn, capture) { assert.equal(capture, true); listeners[type] = fn; } };
  var win = fakeWin('www.youtube.com', { document: doc });
  win.MutationObserver = fakeObserverClass(observers);
  run(win, 'youtube-ad-skip', []);
  var clicks = 0;
  var skip = { click: function () { clicks++; } };
  var playerEl = fakeEl('DIV', {}, ['html5-video-player']);
  var video = { tagName: 'VIDEO', muted: false, duration: 600, currentTime: 3, src: 'blob:content', closest: function () { return playerEl; } };
  playerEl.querySelector = function (sel) { return sel === 'video' ? video : (playerEl.classList.contains('ad-showing') ? skip : null); };
  listeners.loadedmetadata({ target: video });
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].opts.attributeFilter, ['class']);
  // a client-side ad: new src, short duration
  playerEl.classList.add('ad-showing');
  video.src = 'blob:ad'; video.duration = 15; video.currentTime = 0;
  observers[0].cb([]);
  assert.equal(video.muted, true);
  assert.equal(video.currentTime, 15);
  assert.equal(clicks, 1);
  playerEl.classList.remove('ad-showing');
  video.src = 'blob:content'; video.duration = 600; video.currentTime = 0;
  observers[0].cb([]);
  assert.equal(video.muted, false, 'sound restored');
  // same stream as the content (server-side ad): no seek past the video
  playerEl.classList.add('ad-showing');
  video.duration = 60; // short enough that only the same-stream check stops the seek
  video.currentTime = 30;
  observers[0].cb([]);
  assert.equal(video.currentTime, 30, 'no seek inside the content stream');
  assert.equal(video.muted, true);
  listeners.playing({ target: video });
  assert.equal(observers.length, 1, 'one observer per player');
  // the viewer had muted: we leave it muted
  playerEl.classList.remove('ad-showing');
  observers[0].cb([]);
  video.muted = true;
  playerEl.classList.add('ad-showing');
  video.src = 'blob:ad2';
  playerEl.getStatsForNerds = function () { return { debug_info: 'SSAP, AD' }; };
  observers[0].cb([]);
  assert.equal(video.currentTime, 30, 'player says SSAP: no seek');
  playerEl.classList.remove('ad-showing');
  observers[0].cb([]);
  assert.equal(video.muted, true, 'viewer mute kept');
});

/** A player with an ad-skip observer; video.seeks counts writes to currentTime, page.stats getStatsForNerds calls. */
function adSkipPage() {
  var listeners = {}, observers = [];
  var doc = { addEventListener: function (type, fn) { listeners[type] = fn; } };
  var win = fakeWin('www.youtube.com', { document: doc });
  win.MutationObserver = fakeObserverClass(observers);
  run(win, 'youtube-ad-skip', []);
  var page = { clicks: 0, stats: 0, ssap: false };
  var skip = { click: function () { page.clicks++; } };
  page.player = fakeEl('DIV', {}, ['html5-video-player']);
  page.player.getStatsForNerds = function () { page.stats++; return { debug_info: page.ssap ? 'SSAP, AD' : 'x' }; };
  var t = 0;
  page.video = { tagName: 'VIDEO', muted: false, duration: 600, src: 'blob:content', seeks: 0, closest: function () { return page.player; } };
  Object.defineProperty(page.video, 'currentTime', { get: function () { return t; }, set: function (v) { page.video.seeks++; t = v; } });
  page.setTime = function (v) { t = v; };
  page.player.querySelector = function (sel) { return sel === 'video' ? page.video : (page.player.classList.contains('ad-showing') ? skip : null); };
  listeners.loadedmetadata({ target: page.video });
  page.mutate = function () { observers[0].cb([]); };
  page.ad = function (src, duration) {
    page.player.classList.add('ad-showing');
    page.video.src = src; page.video.duration = duration; t = 0;
    page.mutate();
  };
  page.adEnds = function () {
    page.player.classList.remove('ad-showing');
    page.video.src = 'blob:content'; page.video.duration = 600; t = 0;
    page.mutate();
  };
  return page;
}

test('youtube-ad-skip: one seek per ad however many class changes; SSAP check only right before a seek', function () {
  var p = adSkipPage();
  p.mutate(); p.mutate();
  assert.equal(p.stats, 0, 'no ad: getStatsForNerds not called');
  p.ad('blob:ad', 15);
  assert.equal(p.video.seeks, 1);
  assert.equal(p.stats, 1, 'checked once, before the seek');
  // the player has not reached the end yet (MSE seek pending) and ytp-autohide etc. keep toggling
  p.setTime(2);
  p.player.classList.add('ytp-autohide'); p.mutate();
  p.player.classList.remove('ytp-autohide'); p.mutate();
  p.mutate();
  assert.equal(p.video.seeks, 1, 'no repeated seeks into the same ad');
  assert.equal(p.stats, 1, 'no getStatsForNerds per class change');
  assert.equal(p.clicks, 4, 'Skip still clicked on every check');
  // a second ad in the same break (new src / duration): seeked once too
  p.player.classList.add('ad-showing');
  p.video.src = 'blob:ad-2'; p.video.duration = 6; p.setTime(0); p.mutate(); p.mutate();
  assert.equal(p.video.seeks, 2, 'next ad of the break');
  p.adEnds();
  assert.equal(p.video.muted, false, 'sound back');
  p.ad('blob:ad', 15);
  assert.equal(p.video.seeks, 3, 'ad-showing cleared in between: the same src / duration is a new ad');
  // SSAP: no seek, and the player is asked once per ad, not per class change
  p.adEnds();
  p.ssap = true;
  var before = p.stats;
  p.ad('blob:ssap', 20); p.mutate(); p.mutate();
  assert.equal(p.video.seeks, 3, 'SSAP: no seek');
  assert.equal(p.stats, before + 1, 'SSAP verdict remembered for this ad');
});

test('youtube-ad-skip: no seek in an "ad" longer than 90 s (a stitched stream); mute and Skip still work', function () {
  var p = adSkipPage();
  p.ad('blob:long', 91);
  assert.equal(p.video.seeks, 0, 'no seek');
  assert.equal(p.stats, 0, 'nothing to ask the player');
  assert.equal(p.video.muted, true, 'muted');
  assert.equal(p.clicks, 1, 'Skip clicked');
  p.adEnds();
  assert.equal(p.video.muted, false);
  p.ad('blob:short', 90);
  assert.equal(p.video.seeks, 1, '90 s: still seeked');
});

// ------------------------------------------------------------------ YouTube anti-adblock dialog
test('youtube.css: the enforcement dialog is not hidden (hiding left its scroll lock and pauses on)', function () {
  var css = readFile('rules/cosmetic/youtube.css').replace(/\/\*[\s\S]*?\*\//g, '');
  css.split('\n').forEach(function (line) {
    if (/enforcement-message|tp-yt-paper-dialog|iron-overlay-backdrop/.test(line)) {
      assert.notOk(/display\s*:\s*none/.test(line), 'still hidden: ' + line);
    }
  });
  assert.ok(/ytd-enforcement-message-view-model\{animation:as-yt-enf 1ms\}/.test(css), 'detection hook for youtube-enforcement-dismiss');
  assert.ok(/@keyframes as-yt-enf\{/.test(css), 'hook keyframes');
});

/** A YouTube-like page: enforcement dialog (opened), backdrop, scroll lock, a player with a video. */
function enforcementPage(opts) {
  opts = opts || {};
  var listeners = {};
  var page = { closes: 0, plays: 0, removed: 0, now: 1000, listeners: listeners };
  page.html = fakeEl('HTML', {}, []); page.html.style = { overflow: 'hidden' };
  page.body = fakeEl('BODY', { 'no-scroll': '' }, ['no-scroll']); page.body.style = { overflow: 'hidden' };
  page.app = fakeEl('YTD-APP', { 'no-scroll': '' }, []);
  page.dialog = { opened: true, close: function () { page.closes++; page.dialog.opened = false; } };
  page.backdrop = fakeEl('TP-YT-IRON-OVERLAY-BACKDROP', {}, ['opened']);
  page.backdrop.opened = true;
  page.backdrop.close = function () { page.backdrop.opened = false; page.backdrop.classList.remove('opened'); };
  page.enf = fakeEl('YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL');
  page.enf.closest = function (sel) { return sel === 'tp-yt-paper-dialog' ? page.dialog : null; };
  page.inDom = opts.inDom !== false;
  page.player = fakeEl('DIV', {}, ['html5-video-player']);
  page.video = {
    tagName: 'VIDEO', ended: false, seeking: false, readyState: 4,
    closest: function (sel) { return sel === '.html5-video-player' ? page.player : null; },
    play: function () { page.plays++; return Promise.reject(new Error('NotAllowedError')); }
  };
  var doc = {
    documentElement: page.html, body: page.body,
    addEventListener: function (type, fn, capture) { assert.equal(capture, true, type + ' capture'); listeners[type] = fn; },
    querySelector: function (sel) {
      if (sel === 'ytd-enforcement-message-view-model') return page.inDom ? page.enf : null;
      if (sel === 'ytd-app') return page.app;
      return null;
    },
    querySelectorAll: function (sel) { return sel === 'tp-yt-iron-overlay-backdrop' ? [page.backdrop] : []; }
  };
  var win = fakeWin('www.youtube.com', { document: doc });
  win.navigator = opts.navigator !== undefined ? opts.navigator : { userActivation: { isActive: false } };
  win.Date = { now: function () { return page.now; } };
  if (opts.mediaSession) {
    function MediaSession() { this.handlers = {}; }
    MediaSession.prototype.setActionHandler = function setActionHandler(action, fn) { this.handlers[action] = fn; };
    page.MediaSession = MediaSession;
    win.navigator.mediaSession = new MediaSession();
  }
  page.win = win;
  page.pause = function () { listeners.pause({ target: page.video }); };
  run(win, 'youtube-enforcement-dismiss', []);
  return page;
}

test('youtube-enforcement-dismiss: dialog shown -> close(), backdrop closed, scroll lock cleared', function () {
  var p = enforcementPage();
  assert.equal(typeof p.listeners.animationstart, 'function', 'animationstart hook');
  p.listeners.animationstart({ animationName: 'something-else', target: p.enf });
  assert.equal(p.closes, 0, 'other animations ignored');
  assert.equal(p.html.style.overflow, 'hidden', 'nothing unlocked before enforcement');
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  assert.equal(p.closes, 1, 'dialog.close() called');
  assert.equal(p.backdrop.opened, false, 'backdrop closed');
  assert.equal(p.html.style.overflow, '', 'html overflow lock cleared');
  assert.equal(p.body.style.overflow, '', 'body overflow lock cleared');
  assert.notOk(p.body.hasAttribute('no-scroll'), 'body no-scroll attribute removed');
  assert.notOk(p.body.classList.contains('no-scroll'), 'body no-scroll class removed');
  assert.notOk(p.app.hasAttribute('no-scroll'), 'ytd-app no-scroll removed');
  // a dialog without close(): removed instead
  var q = enforcementPage();
  var removed = 0;
  q.dialog.close = undefined;
  q.dialog.remove = function () { removed++; };
  q.listeners.animationstart({ animationName: 'as-yt-enf', target: q.enf });
  assert.equal(removed, 1, 'dialog removed when it has no close()');
  // throwing page objects never escape
  var r = enforcementPage();
  r.dialog.close = function () { throw new Error('boom'); };
  r.listeners.animationstart({ animationName: 'as-yt-enf', target: r.enf });
  r.listeners.animationstart({ animationName: 'as-yt-enf', target: null });
});

test('youtube-enforcement-dismiss: involuntary pause after enforcement -> play(); user pauses kept', function () {
  var p = enforcementPage();
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  p.pause();
  assert.equal(p.plays, 1, 'resumed (rejected play() promise is caught)');
  p.win.navigator.userActivation.isActive = true;
  p.pause();
  assert.equal(p.plays, 1, 'user pause (click, space, k): no resume');
  p.win.navigator.userActivation.isActive = false;
  p.video.ended = true;
  p.pause();
  assert.equal(p.plays, 1, 'ended video: no resume');
  p.video.ended = false;
  p.player.classList.add('ad-showing');
  p.pause();
  assert.equal(p.plays, 1, 'ad playing: no resume');
  p.player.classList.remove('ad-showing');
  p.listeners.pause({ target: { tagName: 'VIDEO', ended: false, closest: function () { return null; }, play: function () { p.plays++; } } });
  assert.equal(p.plays, 1, 'video outside a player: no resume');
  // no fight: a few resumes per window, then it stops until the window has passed
  for (var i = 0; i < 10; i++) p.pause();
  assert.ok(p.plays <= 4, 'throttled: ' + p.plays);
  var capped = p.plays;
  p.now += 60000;
  p.dialog.opened = true; // shown again a minute later (resumes are tied to an open / just-closed dialog)
  p.pause();
  assert.equal(p.plays, capped + 1, 'resumes again later');
});

test('youtube-enforcement-dismiss: no resume once the dialog closed more than 3 s ago', function () {
  var p = enforcementPage();
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  p.now += 2999;
  p.pause();
  assert.equal(p.plays, 1, 'just after the dialog was closed: resumed');
  p.now += 2;
  p.pause();
  assert.equal(p.plays, 1, 'later pauses are the player\'s (quality / source switch, ad -> content): no resume');
  p.now += 600000;
  p.pause();
  assert.equal(p.plays, 1, 'not for the rest of the page either');
  p.dialog.opened = true;
  p.pause();
  assert.equal(p.closes, 2, 'dialog back: closed again');
  assert.equal(p.plays, 2, 'and the pause it caused undone');
});

test('youtube-enforcement-dismiss: no resume while the video is seeking or lacks data (readyState < 3)', function () {
  var p = enforcementPage();
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  p.video.seeking = true;
  p.pause();
  assert.equal(p.plays, 0, 'seeking');
  p.video.seeking = false;
  [0, 1, 2].forEach(function (rs) { p.video.readyState = rs; p.pause(); });
  assert.equal(p.plays, 0, 'readyState < HAVE_FUTURE_DATA');
  p.video.readyState = 3;
  p.pause();
  assert.equal(p.plays, 1, 'HAVE_FUTURE_DATA, not seeking: resumed');
});

test('youtube-enforcement-dismiss: resumes while the dialog stays open, however long', function () {
  var p = enforcementPage();
  p.dialog.close = function () { throw new Error('cannot close'); };
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  p.now += 60000;
  p.pause();
  assert.equal(p.plays, 1, 'dialog still open a minute later: its pause is undone');
});

test('youtube-enforcement-dismiss: no enforcement seen or no userActivation -> no play()', function () {
  var p = enforcementPage({ inDom: false });
  p.pause();
  assert.equal(p.plays, 0, 'no enforcement: pause untouched');
  assert.equal(p.closes, 0);
  assert.equal(p.html.style.overflow, 'hidden', 'no enforcement: page scroll state untouched');
  var q = enforcementPage({ navigator: {} });
  q.listeners.animationstart({ animationName: 'as-yt-enf', target: q.enf });
  q.pause();
  assert.equal(q.closes, 1, 'dialog still dismissed');
  assert.equal(q.plays, 0, 'without navigator.userActivation we cannot tell a user pause: no resume');
});

test('youtube-enforcement-dismiss: without the CSS hook, the pause finds the dialog, dismisses it and resumes', function () {
  var p = enforcementPage();
  p.pause();
  assert.equal(p.closes, 1, 'dialog found on pause and closed');
  assert.equal(p.body.style.overflow, '', 'lock cleared');
  assert.equal(p.plays, 1, 'resumed');
  p.html.style.overflow = 'hidden'; // e.g. a later, unrelated modal
  p.pause();
  assert.equal(p.closes, 1, 'closed dialog not closed again');
  assert.equal(p.html.style.overflow, 'hidden', 'later pauses do not touch other modals\' locks');
});

test('youtube-enforcement-dismiss: pauses from media keys / headphones / PiP (media session) are not resumed', function () {
  var p = enforcementPage({ mediaSession: true });
  var ms = p.win.navigator.mediaSession;
  assert.notOk(Object.prototype.hasOwnProperty.call(ms, 'setActionHandler'), 'patched on the prototype, not the instance');
  var native = p.MediaSession.prototype.setActionHandler;
  var calls = [];
  var pageHandler = function (details) { calls.push(details.action); p.pause(); };
  ms.setActionHandler('pause', pageHandler);
  ms.setActionHandler('enterpictureinpicture', function () {});
  ms.setActionHandler('play', null);
  assert.equal(ms.handlers.play, null, 'null (unset) passed through');
  assert.ok(ms.handlers.pause !== pageHandler, 'pause handler wrapped');
  p.listeners.animationstart({ animationName: 'as-yt-enf', target: p.enf });
  ms.handlers.pause({ action: 'pause' });
  assert.deepEqual(calls, ['pause'], 'page handler still runs');
  assert.equal(p.plays, 0, 'media-key pause: no resume');
  p.now += 2000;
  p.pause();
  assert.equal(p.plays, 1, 'a pause 2 s after the media action, no activation: resumed');
  ['stop', 'seekto', 'previoustrack', 'nexttrack'].forEach(function (action) {
    ms.setActionHandler(action, function () {});
    p.now += 60000;
    p.dialog.opened = true; // the dialog is back, so only the media action stops the resume
    ms.handlers[action]({ action: action });
    p.pause();
    assert.equal(p.plays, 1, action + ': no resume');
  });
  assert.equal(native.name, 'setActionHandler', 'wrapper keeps the name (Proxy of the original)');
  // no mediaSession at all: still sets up
  enforcementPage({ navigator: { userActivation: { isActive: false } } });
});

test('rules: youtube-enforcement-dismiss runs on youtube.com only', function () {
  function names(host) { return R.pick(RULES, host).map(function (s) { return s[0]; }); }
  assert.ok(names('www.youtube.com').indexOf('youtube-enforcement-dismiss') !== -1, 'www.youtube.com');
  assert.ok(names('m.youtube.com').indexOf('youtube-enforcement-dismiss') !== -1, 'm.youtube.com');
  ['example.com', 'notyoutube.com', 'www.youtube-nocookie.com'].forEach(function (h) {
    assert.equal(names(h).indexOf('youtube-enforcement-dismiss'), -1, h);
  });
});

// ------------------------------------------------------------------ edit-request-body (YouTube /player request)
// uBO's "channel" tag edit: the generic scriptlet tests use it (the shipped rule uses "yahi", see the rules test)
var ERB_ARGS = ['/\\/youtubei\\/v1\\/player(\\?|$)/', 'attestationRequest', 'context.client.clientName=="WEB"',
  'context.client.clientScreen="CHANNEL"', 'playbackContext.contentPlaybackContext.referer+=#reloadxhr'];
function erbArgs() { return ERB_ARGS.slice(); }
/** The shipped edit-request-body rule whose URL pattern mentions `endpoint` (player or get_watch). */
function ruleErbArgs(endpoint) {
  var s = R.pick(RULES, 'www.youtube.com').filter(function (x) { return x[0] === 'edit-request-body'; });
  assert.equal(s.length, 2, 'two edit-request-body rules on www.youtube.com (/player and /get_watch)');
  s = s.filter(function (x) { return x[1].indexOf('\\/' + endpoint + '(') !== -1; });
  assert.equal(s.length, 1, 'one edit-request-body rule for ' + endpoint);
  return s[0].slice(1);
}
/** A get_watch request body as YouTube's WEB client sends it on in-page navigation (2026-11-20). */
function getWatchRequestBody(o) {
  o = o || {};
  return JSON.stringify({
    context: { client: { clientName: o.clientName || 'WEB', userAgent: 'Mozilla/5.0 (Macintosh)' } },
    playerRequest: {
      videoId: 'kJQP7kiw5Fk',
      playbackContext: { contentPlaybackContext: { currentUrl: '/watch?v=kJQP7kiw5Fk', referer: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } },
      serviceIntegrityDimensions: { poToken: 'tok' }
    },
    watchNextRequest: { videoId: 'kJQP7kiw5Fk', playbackContext: { vis: 0 } }
  });
}
function playerRequestBody(o) {
  o = o || {};
  var b = {
    videoId: 'kJQP7kiw5Fk',
    context: { client: { clientName: o.clientName || 'WEB', clientScreen: 'WATCH_FULL_SCREEN', userAgent: 'Mozilla/5.0 (Macintosh)' } },
    playbackContext: { contentPlaybackContext: { referer: o.referer || 'https://www.youtube.com/watch?v=kJQP7kiw5Fk', html5Preference: 'HTML5_PREF_WANTS' } },
    cpn: 'abc'
  };
  if (!o.noAttestation) b.attestationRequest = { omitBotguardData: true };
  return JSON.stringify(b);
}
function assertEditedBody(text, msg) {
  var o = JSON.parse(text);
  assert.equal(o.context.client.clientScreen, 'CHANNEL', msg + ': clientScreen');
  assert.equal(o.playbackContext.contentPlaybackContext.referer, 'https://www.youtube.com/watch?v=kJQP7kiw5Fk#reloadxhr', msg + ': referer');
  assert.equal(o.context.client.userAgent, 'Mozilla/5.0 (Macintosh)', msg + ': userAgent untouched');
  assert.equal(o.playbackContext.contentPlaybackContext.html5Preference, 'HTML5_PREF_WANTS', msg + ': other keys kept');
  assert.deepEqual(Object.keys(o), ['videoId', 'context', 'playbackContext', 'cpn', 'attestationRequest'], msg + ': key order kept');
}
/** fetch that records its arguments and answers {} */
function recordingFetch(win) {
  win.sent = [];
  var Resp = win.Response;
  win.fetch = function fetch(input, init) { win.sent.push({ input: input, init: init, n: arguments.length }); return Promise.resolve(new Resp('{}')); };
}

test('edit-request-body: /player fetch with a string body and attestationRequest is edited', function () {
  var win = fakeWin('www.youtube.com');
  recordingFetch(win);
  run(win, 'edit-request-body', erbArgs());
  var init = { method: 'POST', body: playerRequestBody(), credentials: 'same-origin' };
  return win.fetch('/youtubei/v1/player?prettyPrint=false', init).then(function () {
    var s = win.sent[0];
    assert.equal(s.input, '/youtubei/v1/player?prettyPrint=false', 'same URL');
    assert.ok(s.init !== init, 'a copy of init');
    assert.equal(s.init.credentials, 'same-origin', 'other init fields kept');
    assert.equal(init.body, playerRequestBody(), "the page's own init object is not changed");
    assertEditedBody(s.init.body, 'fetch');
    // already #reloadxhr: not appended twice
    return win.fetch('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: playerRequestBody({ referer: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk#reloadxhr' }) });
  }).then(function () {
    assertEditedBody(win.sent[1].init.body, 'already tagged referer');
  });
});

test('edit-request-body: untouched for /next, /player without the needle, non-string bodies and non-WEB clients', function () {
  var win = fakeWin('www.youtube.com');
  recordingFetch(win);
  var c = countingLib();
  c.lib.scriptlets['edit-request-body'](win, erbArgs(), log);
  var cases = [
    ['/youtubei/v1/next?prettyPrint=false', { method: 'POST', body: playerRequestBody() }],
    ['/youtubei/v1/player/heartbeat?prettyPrint=false', { method: 'POST', body: playerRequestBody() }],
    ['/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: playerRequestBody({ noAttestation: true }) }],
    ['/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: { attestationRequest: 1 } }],
    ['/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: new Uint8Array([123, 125]) }],
    ['/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: playerRequestBody({ clientName: 'MWEB' }) }],
    ['/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: '{"attestationRequest":' }]
  ];
  var parsesBefore = c.parses;
  return Promise.all(cases.map(function (k) { return win.fetch(k[0], k[1]); })).then(function () {
    cases.forEach(function (k, i) {
      assert.ok(win.sent[i].init === k[1], 'same init object: ' + i);
      assert.ok(win.sent[i].init.body === k[1].body, 'same body: ' + i);
    });
    assert.equal(c.parses - parsesBefore, 2, 'only the two needle-bearing /player string bodies (MWEB, truncated) were parsed');
    return win.fetch('/youtubei/v1/player?prettyPrint=false');
  }).then(function () {
    assert.equal(win.sent[cases.length].n, 1, 'plain fetch(url) passed through with its own arguments');
  });
});

test('edit-request-body: XMLHttpRequest.send(string) on /player edited; /next, needle-free and non-string untouched', function () {
  var win = fakeWin('www.youtube.com');
  var bodies = [];
  win.XMLHttpRequest.prototype.send = function (b) { bodies.push(b); };
  run(win, 'edit-request-body', erbArgs());
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/player?prettyPrint=false');
  x.send(playerRequestBody());
  assertEditedBody(bodies[0], 'XHR');
  x.open('POST', '/youtubei/v1/next?prettyPrint=false'); // the same xhr reused for another URL
  x.send(playerRequestBody());
  assert.equal(bodies[1], playerRequestBody(), '/next untouched');
  x.open('POST', '/youtubei/v1/player');
  x.send(playerRequestBody({ noAttestation: true }));
  assert.equal(bodies[2], playerRequestBody({ noAttestation: true }), 'no needle: untouched');
  var blob = { size: 3 };
  x.open('POST', '/youtubei/v1/player');
  x.send(blob);
  assert.ok(bodies[3] === blob, 'non-string body untouched');
  x.send();
  assert.equal(bodies[4], undefined, 'no body');
});

/** Request / Response / gzip stream fakes: "gzip" data is 'GZ:' + text. */
function requestWin(opts) {
  opts = opts || {};
  var win = fakeWin('www.youtube.com');
  function Stream(data) { this.data = data; }
  Stream.prototype.pipeThrough = function (t) { return new Stream(t.run(this.data)); };
  function CResp(body) { this._data = body instanceof Stream ? body.data : body; }
  Object.defineProperty(CResp.prototype, 'body', { get: function () { return new Stream(this._data); } });
  CResp.prototype.text = function () { return Promise.resolve(String(this._data)); };
  CResp.prototype.arrayBuffer = function () { return Promise.resolve(this._data); };
  win.Response = CResp;
  win.codec = [];
  if (!opts.noCodec) {
    win.DecompressionStream = function (f) { win.codec.push('gunzip ' + f); this.run = function (d) { if (String(d).indexOf('GZ:') !== 0) throw new Error('not gzip'); return String(d).slice(3); }; };
    win.CompressionStream = function (f) { win.codec.push('gzip ' + f); this.run = function (d) { return 'GZ:' + d; }; };
  }
  function Req(input, init) {
    init = init || {};
    var src = typeof input === 'string' ? { url: input, method: 'GET', headers: new FakeHeaders(), _body: null } : input;
    this.url = src.url;
    this.method = init.method || src.method;
    this.headers = init.headers ? new FakeHeaders(init.headers) : new FakeHeaders(src.headers);
    this._body = init.body !== undefined ? init.body : src._body;
    this.bodyUsed = false;
    this.signal = src.signal;
    win.clones = win.clones || 0;
  }
  Object.defineProperty(Req.prototype, 'body', { get: function () { return this._body === null ? null : new Stream(this._body); } });
  Req.prototype.clone = function () { win.clones++; return new Req(this); };
  Req.prototype.text = function () { this.bodyUsed = true; return Promise.resolve(String(this._body)); };
  win.Request = Req;
  recordingFetch(win);
  return win;
}

test('edit-request-body: fetch(Request) on /player edited, gzip bodies gunzipped and gzipped again', function () {
  var win = requestWin();
  run(win, 'edit-request-body', erbArgs());
  var plain = new win.Request('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: playerRequestBody(), headers: { 'content-type': 'application/json' } });
  var gz = new win.Request('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: 'GZ:' + playerRequestBody(), headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  gz.signal = 'sig';
  return win.fetch(plain).then(function () {
    var s = win.sent[0];
    assert.ok(s.input !== plain && s.input instanceof win.Request, 'a new Request');
    assert.equal(s.input.url, plain.url, 'same URL');
    assert.equal(s.input.method, 'POST', 'same method');
    assert.equal(s.input.headers.get('content-type'), 'application/json', 'headers kept');
    assertEditedBody(s.input._body, 'Request');
    assert.notOk(plain.bodyUsed, "the page's Request body is not consumed");
    assert.deepEqual(win.codec, [], 'no codec for a plain body');
    return win.fetch(gz);
  }).then(function () {
    var s = win.sent[1];
    assert.deepEqual(win.codec, ['gunzip gzip', 'gzip gzip'], 'gunzip, then gzip');
    assert.equal(s.input.headers.get('content-encoding'), 'gzip', 'still gzip');
    assert.equal(String(s.input._body).slice(0, 3), 'GZ:', 'body gzipped again');
    assertEditedBody(String(s.input._body).slice(3), 'gzip Request');
    assert.equal(s.input.signal, 'sig', 'Request built from the original (signal kept)');
  });
});

test('edit-request-body: fetch(Request) untouched for /next, no needle, no codec, unknown encoding, GET', function () {
  var win = requestWin();
  run(win, 'edit-request-body', erbArgs());
  var next = new win.Request('/youtubei/v1/next?prettyPrint=false', { method: 'POST', body: playerRequestBody() });
  var noNeedle = new win.Request('/youtubei/v1/player', { method: 'POST', body: playerRequestBody({ noAttestation: true }) });
  var br = new win.Request('/youtubei/v1/player', { method: 'POST', body: 'xx', headers: { 'content-encoding': 'br' } });
  var get = new win.Request('/youtubei/v1/player');
  var notGzip = new win.Request('/youtubei/v1/player', { method: 'POST', body: playerRequestBody(), headers: { 'content-encoding': 'gzip' } });
  var reqs = [next, noNeedle, br, get, notGzip];
  return Promise.all(reqs.map(function (r) { return win.fetch(r); })).then(function () {
    var inputs = win.sent.map(function (x) { return x.input; });
    assert.equal(inputs.length, reqs.length, 'all sent');
    reqs.forEach(function (r, i) { assert.ok(inputs.indexOf(r) !== -1, 'same Request object: ' + i); });
    assert.equal(win.clones, 2, 'only the needle-free POST and the bad gzip body were read (from clones)');
    var noCodec = requestWin({ noCodec: true });
    run(noCodec, 'edit-request-body', erbArgs());
    var gz = new noCodec.Request('/youtubei/v1/player', { method: 'POST', body: 'GZ:' + playerRequestBody(), headers: { 'content-encoding': 'gzip' } });
    return noCodec.fetch(gz).then(function () {
      assert.ok(noCodec.sent[0].input === gz, 'no CompressionStream: sent as it came');
      assert.equal(noCodec.clones, 0, 'not read');
    });
  });
});

test('edit-request-body: bad arguments install nothing; no JSON.stringify / JSON.parse / Promise.prototype.then patch', function () {
  var win = fakeWin('www.youtube.com');
  var fetch0 = win.fetch, send0 = win.XMLHttpRequest.prototype.send;
  [[], ['/player/', 'attestationRequest'], ['/player/', '', 'a=1'], ['/player/', 'x', 'a=notjson'], ['/player/', 'x', 'a==1'], ['/player/', 'x', 'nonsense']].forEach(function (args) {
    run(win, 'edit-request-body', args);
    assert.ok(win.fetch === fetch0 && win.XMLHttpRequest.prototype.send === send0, 'nothing installed for ' + JSON.stringify(args));
  });
  var parse0 = win.JSON.parse, stringify0 = win.JSON.stringify, then0 = win.Promise.prototype.then;
  run(win, 'edit-request-body', erbArgs());
  assert.ok(win.fetch !== fetch0 && win.XMLHttpRequest.prototype.send !== send0, 'fetch and XHR send wrapped');
  assert.ok(win.JSON.stringify === stringify0 && win.JSON.parse === parse0, 'JSON untouched');
  assert.notOk(Object.prototype.hasOwnProperty.call(win.Promise.prototype, 'then'), 'no then on the page Promise');
  assert.ok(win.Promise.prototype.then === then0, 'then untouched');
  assert.ok(L.scriptlets['edit-request-body'].frames, 're-applied to same-origin child frames');
});

test('rules: edit-request-body (uBO "oaeb" edit) for the youtubei /player request on youtube.com only', function () {
  var args = ruleErbArgs('player');
  assert.deepEqual(args, ['/\\/youtubei\\/v1\\/player(\\?|$)/', 'attestationRequest', 'context.client.clientName=="WEB"',
    'params="oAEBogYBLg"', 'playbackContext.contentPlaybackContext.referer+=#reloadxhr']);
  assert.equal(args.join(' ').indexOf('CHANNEL'), -1, 'not clientScreen CHANNEL (UNPLAYABLE, measured 2026-11-19)');
  assert.equal(args.join(' ').indexOf('YAHI'), -1, 'not params YAHI (still a 4-9 s SABR backoff, measured 2026-11-20)');
  ['example.com', 'notyoutube.com'].forEach(function (h) {
    assert.equal(R.pick(RULES, h).filter(function (s) { return s[0] === 'edit-request-body'; }).length, 0, h);
  });
  var about = RULES.rules.filter(function (r) { return r.id === 'youtube'; })[0].about;
  ['ef0ac51', 'dcf5811', '1fbf62c', 'oAEBogYBLg'].forEach(function (x) { assert.includes(about, x); });
  var win = fakeWin('www.youtube.com');
  recordingFetch(win);
  R.run(win, L, RULES, log);
  return win.fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: playerRequestBody() }).then(function () {
    var o = JSON.parse(win.sent[0].init.body);
    assert.equal(o.params, 'oAEBogYBLg', 'params');
    assert.equal(o.context.client.clientScreen, 'WATCH_FULL_SCREEN', 'clientScreen untouched');
    assert.equal(o.playbackContext.contentPlaybackContext.referer, 'https://www.youtube.com/watch?v=kJQP7kiw5Fk#reloadxhr', 'referer');
  });
});

test('rules: edit-request-body (uBO "oaeb" edit) on the playerRequest of get_watch, the in-page navigation request', function () {
  var args = ruleErbArgs('get_watch');
  assert.deepEqual(args, ['/\\/youtubei\\/v1\\/get_watch(\\?|$)/', 'playerRequest', 'context.client.clientName=="WEB"',
    'playerRequest.params="oAEBogYBLg"', 'playerRequest.playbackContext.contentPlaybackContext.referer+=#reloadxhr']);
  var win = requestWin();
  R.run(win, L, RULES, log);
  var gz = new win.Request('/youtubei/v1/get_watch?prettyPrint=false', { method: 'POST', body: 'GZ:' + getWatchRequestBody(), headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  return win.fetch(gz).then(function () {
    var s = win.sent[0];
    assert.equal(String(s.input._body).slice(0, 3), 'GZ:', 'body gzipped again');
    var o = JSON.parse(String(s.input._body).slice(3));
    assert.equal(o.playerRequest.params, 'oAEBogYBLg', 'playerRequest.params');
    assert.equal(o.playerRequest.playbackContext.contentPlaybackContext.referer, 'https://www.youtube.com/watch?v=jNQXAC9IVRw#reloadxhr', 'referer');
    assert.equal(o.params, undefined, 'no top-level params added');
    assert.deepEqual(o.watchNextRequest, { videoId: 'kJQP7kiw5Fk', playbackContext: { vis: 0 } }, 'watchNextRequest untouched');
    assert.equal(o.playerRequest.serviceIntegrityDimensions.poToken, 'tok', 'poToken kept');
    var plain = new win.Request('/youtubei/v1/get_watch', { method: 'POST', body: getWatchRequestBody({ clientName: 'MWEB' }) });
    return win.fetch(plain);
  }).then(function () {
    assert.equal(win.sent[1].input._body, getWatchRequestBody({ clientName: 'MWEB' }), 'client MWEB untouched');
    return win.fetch(new win.Request('/youtubei/v1/next', { method: 'POST', body: getWatchRequestBody() }));
  }).then(function () {
    assert.equal(win.sent[2].input._body, getWatchRequestBody(), '/next untouched');
  });
});

// ------------------------------------------------------------------ the generated bundle
test('build/scriptlets-main.js: runs the YouTube rules on a YouTube window, nothing elsewhere, leaves no globals', function () {
  var src = readFile('build/scriptlets-main.js');
  var yt = fakeWin('www.youtube.com');
  new Function('window', src)(yt);
  assertPlayerClean(yt.JSON.parse(PLAYER), 'bundle');
  var other = fakeWin('example.com');
  var parse = other.JSON.parse;
  new Function('window', src)(other);
  assert.ok(other.JSON.parse === parse, 'other site untouched');
  assert.ok(/^\/\/ GENERATED[^\n]*\n\(function \(\) \{\n/.test(src) && /\}\)\(\);\n$/.test(src), 'one function scope: no page globals');
  new Function('window', src)(null);
});
