/*
 * The generated bundles (build/*.js, from tools/build.py) load without throwing against browser
 * stubs and work together: the MAIN-world bundle hooks fetch and Worker, the ISOLATED-world
 * bundle stays inert without chrome.* and, with it, hands the stored settings to the page.
 * tests/run.sh rebuilds the bundles before the jsc tests run.
 */
load('tests/lib/browser-stubs.js');
var env = installBrowserStubs({ chrome: true });
var stubFetch = globalThis.fetch;
var TWITCH_WORKER = 'https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min.js';

test('main-world.js loads: fetch and Worker hooked, namespace removed, hello sent', function () {
  load('build/main-world.js');
  assert.ok(globalThis.fetch !== stubFetch, 'fetch hooked');
  assert.ok(globalThis.Worker !== env.OriginalWorker, 'Worker hooked');
  assert.equal(typeof globalThis.__TAS__, 'undefined', 'namespace removed from the page');
  var hellos = env.messages('tas:to-bridge').filter(function (m) { return m.type === 'hello'; });
  assert.equal(hellos.length, 1);
});

test('main-world.js (2.0): health.js bundled, recovery.js gone, no autoplay in the default order', function () {
  var src = readFile('build/main-world.js');
  assert.includes(src, 'createHealth');
  assert.notIncludes(src, 'createRecovery');
  assert.notIncludes(src, 'setSrc(', 'no player reloads');
  assert.notIncludes(src, "backupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed', 'autoplay']");
  assert.includes(src, "backupPlayerTypes: ['popout', 'embed', 'site', 'mobile_web']");
});

test('main-world.js: a Twitch worker gets a wrapped source that compiles', function () {
  var w = new Worker(TWITCH_WORKER);
  assert.equal(w.scriptURL.indexOf('blob:'), 0);
  var src = env.blobs[w.scriptURL].text;
  assert.includes(src, '__TAS_WORKER__');
  new Function(src);
  var other = new Worker('https://example.invalid/w.js');
  assert.equal(other.scriptURL, 'https://example.invalid/w.js', 'non-Twitch worker untouched');
});

test('isolated-world.js without chrome.* loads and does nothing', function () {
  var savedChrome = globalThis.chrome;
  var before = env.dispatched.length;
  try {
    delete globalThis.chrome;
    load('build/isolated-world.js');
  } finally {
    globalThis.chrome = savedChrome;
  }
  assert.equal(env.dispatched.length, before, 'no messages');
  assert.notOk(globalThis.__tas_bridge_installed__);
});

test('isolated-world.js with chrome.*: handshake with the page, stored "off" reaches the page', function () {
  var off = JSON.parse(JSON.stringify(globalThis.__TAS__.settings.defaults()));
  off.enabled = false;
  env.stored.settings = off;
  load('build/isolated-world.js');
  assert.ok(globalThis.__tas_bridge_installed__);
  return Promise.resolve().then(function () {}).then(function () {
    assert.ok(env.sentToBackground.some(function (m) { return m.type === 'tab-hello'; }), 'page hello reached the background');
    var w = new Worker(TWITCH_WORKER);
    assert.equal(w.scriptURL, TWITCH_WORKER, 'extension off: worker not wrapped');
  });
});
