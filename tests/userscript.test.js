/*
 * dist/ad-shield.user.js (tools/build.py render_userscript): the single userscript for Safari's
 * Userscripts app. Header fields, the file parses, YouTube hosts get the scriptlets and the
 * cosmetic CSS, Twitch hosts get the MAIN-world bundle, nothing needs chrome.*, and a second
 * injection is a no-op. tests/run.sh rebuilds dist/ad-shield.user.js before the jsc tests run.
 *
 * The userscript reads the page's window through the free name `window`; YouTube and clips cases
 * pass a fake window (new Function('window', src)(fake)) so the harness's own globals stay
 * unpatched, the Twitch case passes globalThis (the Twitch files use globalThis themselves).
 */
load('tests/lib/browser-stubs.js');
var env = installBrowserStubs({ chrome: false });
var stubFetch = globalThis.fetch;
var SRC = readFile('dist/ad-shield.user.js');
var MANIFEST = JSON.parse(readFile('manifest.json'));
var PLAYER = readFile('tests/fixtures/youtube-player.json');
var TWITCH_WORKER = 'https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min.js';

function header() {
  var lines = SRC.split('\n');
  var end = lines.indexOf('// ==/UserScript==');
  return { lines: lines.slice(1, end), end: end, first: lines[0] };
}
function fields() {
  var out = {};
  header().lines.forEach(function (l) {
    var m = /^\/\/ @(\S+)\s+(.+)$/.exec(l);
    if (!m) throw new Error('bad header line: ' + l);
    (out[m[1]] = out[m[1]] || []).push(m[2].trim());
  });
  return out;
}
function fakeWin(host) {
  return {
    location: { hostname: host },
    document: globalThis.document,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Promise: (function () { class P extends Promise {} return P; })(),
    fetch: function () { return Promise.resolve({}); },
    setTimeout: function () { return 1; }
  };
}
function styles() {
  return env.created.filter(function (e) { return e.nodeName === 'STYLE'; });
}
/** The code, without comment-only lines (for checks on executed code). */
function codeOnly() {
  return SRC.split('\n').filter(function (l) {
    var t = l.trim();
    return !(t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0);
  }).join('\n');
}

test('header: ==UserScript== block with one value per required key', function () {
  var h = header();
  assert.equal(h.first, '// ==UserScript==');
  assert.ok(h.end > 1, 'closing ==/UserScript== line');
  var f = fields();
  assert.deepEqual(f.name, ['Ad Shield (YouTube + Twitch)'], 'exactly one @name');
  assert.deepEqual(f.version, [MANIFEST.version], '@version = manifest version');
  assert.deepEqual(f['run-at'], ['document-start']);
  assert.deepEqual(f['inject-into'], ['page']);
  assert.deepEqual(f.grant, ['none']);
  assert.deepEqual(f.license, ['MIT']);
  assert.equal(f.description.length, 1);
  assert.equal(f.namespace.length, 1);
  assert.notOk(/[\w.+-]+@[\w-]+\.[a-z]/i.test(SRC.slice(0, SRC.indexOf('// ==/UserScript=='))), 'no e-mail address in the header');
  assert.deepEqual(f['exclude-match'], ['https://clips.twitch.tv/*']);
});

test('header: @match covers each host and its subdomains (YouTube family and Twitch)', function () {
  var m = fields().match;
  ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com', 'twitch.tv'].forEach(function (h) {
    assert.ok(m.indexOf('*://' + h + '/*') !== -1, 'root form for ' + h);
    assert.ok(m.indexOf('*://*.' + h + '/*') !== -1, 'subdomain form for ' + h);
  });
  m.forEach(function (p) { assert.ok(/^\*:\/\/(\*\.)?[a-z0-9.-]+\/\*$/.test(p), 'pattern ' + p); });
});

test('the whole file parses; generated note after the header; one function scope', function () {
  new Function(SRC);
  var after = SRC.split('\n').slice(header().end + 1, header().end + 4).join('\n');
  assert.includes(after, 'tools/build.py');
  assert.includes(after, 'MIT');
  assert.includes(after, 'docs/IOS.md');
  assert.ok(/\n\(function \(win\) \{\n/.test(SRC) && /\}\)\(window\);\n$/.test(SRC), 'one function scope');
});

test('no executed chrome.* API use', function () {
  assert.notOk(/\bchrome\s*\.\s*[a-zA-Z]/.test(codeOnly()), 'chrome.<api> outside comments');
  assert.equal(typeof globalThis.chrome, 'undefined', 'test runs without chrome.*');
});

test('YouTube host: scriptlets prune JSON.parse, style added, Twitch hooks not installed', function () {
  var yt = fakeWin('www.youtube.com');
  var parse = yt.JSON.parse;
  var before = styles().length;
  new Function('window', SRC)(yt);
  assert.ok(yt.JSON.parse !== parse, 'JSON.parse hooked on the page window');
  var o = yt.JSON.parse(PLAYER);
  assert.equal(o.adPlacements, undefined, 'adPlacements');
  assert.equal(o.playerAds, undefined, 'playerAds');
  assert.equal(o.adSlots, undefined, 'adSlots');
  assert.equal(o.videoDetails.videoId, 'jNQXAC9IVRw', 'videoDetails kept');
  var added = styles().slice(before);
  assert.equal(added.length, 1, 'one style element');
  var st = added[0];
  assert.equal(st.id, 'ad-shield-css');
  assert.includes(st.textContent, 'ytd-ad-slot-renderer{display:none!important}');
  assert.equal(st.textContent, readFile('rules/cosmetic/youtube.css'), 'CSS embedded verbatim');
  assert.ok(st.parentNode === document.head || st.parentNode === document.documentElement, 'attached');
  assert.ok(globalThis.fetch === stubFetch, 'fetch not hooked by the Twitch part');
  assert.ok(globalThis.Worker === env.OriginalWorker, 'Worker not hooked by the Twitch part');
  assert.notOk(Object.keys(yt).indexOf('__adShieldUserscript__') !== -1, 'marker not enumerable');
  assert.ok(yt.__adShieldUserscript__, 'marker set');
});

test('YouTube host: the style comes back after the SPA removes it; second injection is a no-op', function () {
  var yt = fakeWin('m.youtube.com');
  var before = styles().length;
  new Function('window', SRC)(yt);
  var st = styles()[before];
  st.parentNode.removeChild(st);
  assert.ok(!st.parentNode, 'removed');
  document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
  assert.ok(st.parentNode === document.head || st.parentNode === document.documentElement, 're-added');
  var parse = yt.JSON.parse;
  new Function('window', SRC)(yt);
  assert.ok(yt.JSON.parse === parse, 'second run did not hook again');
  assert.equal(styles().length, before + 1, 'no second style element');
});

test('other hosts (example.com, notyoutube.com, clips.twitch.tv): nothing happens', function () {
  ['example.com', 'notyoutube.com', 'clips.twitch.tv'].forEach(function (h) {
    var w = fakeWin(h);
    var parse = w.JSON.parse;
    var before = styles().length;
    new Function('window', SRC)(w);
    assert.ok(w.JSON.parse === parse, h + ': JSON.parse untouched');
    assert.equal(styles().length, before, h + ': no style');
    assert.ok(globalThis.fetch === stubFetch, h + ': fetch untouched');
    assert.ok(globalThis.Worker === env.OriginalWorker, h + ': Worker untouched');
  });
});

test('Twitch host: fetch and Worker hooked, namespace removed, no YouTube CSS, works without a bridge', function () {
  assert.equal(location.hostname, 'www.twitch.tv');
  var before = styles().length;
  new Function('window', SRC)(globalThis);
  assert.ok(globalThis.fetch !== stubFetch, 'fetch hooked');
  assert.ok(globalThis.Worker !== env.OriginalWorker, 'Worker hooked');
  assert.equal(typeof globalThis.__TAS__, 'undefined', 'namespace removed from the page');
  assert.equal(styles().length, before, 'no YouTube style on Twitch');
  var w = new Worker(TWITCH_WORKER);
  assert.equal(w.scriptURL.indexOf('blob:'), 0, 'Twitch worker wrapped with default settings');
  new Function(env.blobs[w.scriptURL].text);
  var other = new Worker('https://example.invalid/w.js');
  assert.equal(other.scriptURL, 'https://example.invalid/w.js', 'non-Twitch worker untouched');
});

test('Twitch host: second injection is a no-op', function () {
  var f = globalThis.fetch, W = globalThis.Worker;
  new Function('window', SRC)(globalThis);
  assert.ok(globalThis.fetch === f && globalThis.Worker === W, 'not hooked twice');
});
