/*
 * Every extension JavaScript file must compile, and every core factory must be self-contained
 * (inlinable into the worker via Function.prototype.toString: it must run when evaluated in
 * an empty scope).
 */
var FILES = [
  'src/config.js', 'src/shared/settings.js', 'src/shared/logger.js', 'src/shared/frame.js', 'src/shared/stats.js',
  'src/core/m3u8.js', 'src/core/gql.js', 'src/core/processor.js', 'src/core/worker-source.js',
  'src/worker/worker-main.js', 'src/page/health.js', 'src/page/page.js',
  'src/content/cosmetic.js', 'src/content/bridge.js',
  'src/background/service-worker.js', 'src/popup/popup.js', 'src/options/options.js',
  'src/shared/blocking.js', 'src/background/general.js', 'src/background/autoconsent-shim.js', 'src/content/general.js',
  'src/shared/filterlist.js', 'src/shared/lists.js', 'src/background/updater.js',
  'src/scriptlets/lib.js', 'src/scriptlets/runner.js', 'build/scriptlets-main.js',
  'src/shared/selector.js', 'src/shared/userfilters.js', 'src/content/picker.js'
];

FILES.forEach(function (f) {
  test('compiles: ' + f, function () {
    new Function(readFile(f));
  });
});

test('factories are self-contained (no outer-scope references)', function () {
  loadSrc('src/config.js', 'src/shared/logger.js', 'src/core/m3u8.js', 'src/core/gql.js', 'src/core/processor.js', 'src/worker/worker-main.js');
  var ns = __TAS__;
  ['m3u8Factory', 'gqlFactory', 'processorFactory', 'loggerFactory'].forEach(function (k) {
    var src = ns[k].toString();
    // Evaluate in a fresh function scope that shadows the namespace and config globals.
    var api = new Function('__TAS__', 'ns', 'cfg', 'root', 'return (' + src + ')();')();
    assert.ok(api, k + ' produced a value');
  });
  var cfgCopy = JSON.parse(JSON.stringify(ns.config));
  var M = new Function('return (' + ns.m3u8Factory.toString() + ')();')();
  assert.ok(M.hasAds(fixture('preroll.m3u8'), cfgCopy), 'inlined m3u8 works with a JSON copy of the config');
});

test('page.js does nothing without the namespace (no throw)', function () {
  var saved = globalThis.__TAS__;
  try {
    delete globalThis.__TAS__;
    load('src/page/page.js');
  } finally {
    globalThis.__TAS__ = saved;
  }
});

test('no line/paragraph separator characters in sources', function () {
  FILES.forEach(function (f) {
    var s = readFile(f);
    assert.equal(s.indexOf(String.fromCharCode(0x2028)), -1, f);
    assert.equal(s.indexOf(String.fromCharCode(0x2029)), -1, f);
  });
});
