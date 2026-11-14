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
test('wrapped functions keep name / length and look native through the patched toString', function () {
  var FP = { toString: Function.prototype.toString };
  var win = fakeWin();
  win.Function = { prototype: FP };
  var orig = win.JSON.parse;
  run(win, 'json-prune', ['adPlacements']);
  assert.ok(win.JSON.parse !== orig);
  assert.equal(win.JSON.parse.name, 'parse');
  assert.equal(win.JSON.parse.length, 2);
  assert.equal(FP.toString.call(win.JSON.parse), Function.prototype.toString.call(orig));
  assert.includes(FP.toString.call(FP.toString), '[native code]', 'the toString patch hides itself');
  assert.throws(function () { FP.toString.call(5); }, 'non-functions still throw');
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

test('YouTube rules end to end: initial globals, JSON.parse, fetch, XHR, Shorts, ytcfg flag, abnormality reporter', function () {
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
  win.ytcfg = { data_: {} };
  win.ytcfg.data_.EXPERIMENT_FLAGS = { web_streaming_watch: true };
  assert.equal(win.ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, false);
  var x = new win.XMLHttpRequest();
  x.open('POST', '/youtubei/v1/player?prettyPrint=false');
  x.send();
  assertPlayerClean(JSON.parse(x.responseText), 'XHR');
  var hits = [];
  win.Promise.resolve().then(function () { hits.push('a'); this.onAbnormalityDetected(); });
  return win.fetch('/youtubei/v1/player?prettyPrint=false').then(function (r) { return r.text(); }).then(function (t) {
    assertPlayerClean(JSON.parse(t), 'fetch /player');
    return win.fetch('/youtubei/v1/browse?prettyPrint=false');
  }).then(function (r) { return r.text(); }).then(function (t) {
    assert.deepEqual(feedIds(JSON.parse(t)), ['a', 'b', 'more', 'c'], 'fetch /browse');
    return win.fetch('/youtubei/v1/reel/reel_watch_sequence?x=1');
  }).then(function (r) { return r.json(); }).then(function (o) {
    assert.equal(o.entries.length, 2, 'Shorts ad entry removed');
    return win.fetch('/youtubei/v1/player/heartbeat');
  }).then(function (r) {
    assert.equal(r.headers.get('content-length'), '999', 'heartbeat not matched by the URL pattern');
    assert.deepEqual(hits, []);
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
