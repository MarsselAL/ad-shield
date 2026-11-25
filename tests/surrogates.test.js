/*
 * src/surrogates/*.js: the stand-ins the ads_surrogates / privacy_surrogates DNR rules redirect
 * blocked Google scripts to. Each one runs here against a fresh fake `window`, the way a page
 * would load it, and must define the page-facing API and release callbacks pages wait for.
 */

function run(file, win) {
  new Function('window', readFile('src/surrogates/' + file))(win);
  return win;
}

var REDIRECTED = (function () {
  var out = {};
  ['rules/ads_surrogates.json', 'rules/privacy_surrogates.json'].forEach(function (f) {
    JSON.parse(readFile(f)).forEach(function (r) { out[r.action.redirect.extensionPath.replace(/^\//, '')] = true; });
  });
  return Object.keys(out).sort();
})();

test('every redirect target compiles, is web accessible and runs on an empty window', function () {
  var war = JSON.parse(readFile('manifest.json')).web_accessible_resources;
  assert.deepEqual(war[0].resources, REDIRECTED, 'manifest lists exactly the redirect targets');
  REDIRECTED.forEach(function (p) {
    var src = readFile(p);
    new Function(src);
    assert.notIncludes(src, 'fetch(', p + ': no requests');
    assert.notIncludes(src, 'XMLHttpRequest', p + ': no requests');
    run(p.replace('src/surrogates/', ''), {});
  });
});

test('analytics.js: window.ga API, queued commands replayed, ready and hit callbacks fire', function () {
  var seen = [];
  var q = [['create', 'UA-1-1', 'auto'], ['send', 'pageview', { hitCallback: function () { seen.push('queued hit'); } }]];
  var win = run('analytics.js', { ga: { q: q, l: 5 } });
  var ga = win.ga;
  assert.equal(typeof ga, 'function');
  assert.equal(ga.loaded, true);
  assert.equal(ga.l, 5);
  assert.equal(ga.getAll().length, 1, 'the queued create made tracker t0');
  assert.equal(ga.getByName('t0').get('name'), 't0');
  assert.equal(ga.getByName('nope'), null);
  ga(function (tracker) { seen.push('ready ' + tracker.get('name')); });
  ga('send', 'event', 'cat', 'act', { hitCallback: function () { seen.push('event hit'); } });
  ga('set', 'hitCallback', function () { seen.push('set hit'); });
  ga('send', 'pageview');
  ga('other.send', { hitType: 'event', hitCallback: function () { seen.push('unknown tracker hit'); } });
  assert.deepEqual(seen, [], 'callbacks run asynchronously');
  __advanceTimers(10);
  assert.deepEqual(seen, ['queued hit', 'ready t0', 'event hit', 'set hit', 'unknown tracker hit']);
  var t = ga.create('UA-2-2', 'auto', 'second');
  assert.equal(t.get('name'), 'second');
  ga.remove('second');
  assert.equal(ga.getAll().length, 1);
  var custom = run('analytics.js', { GoogleAnalyticsObject: '__gaTracker' });
  assert.equal(typeof custom.__gaTracker, 'function', 'GoogleAnalyticsObject names the global');
  assert.equal(custom.ga, undefined);
});

test('ga.js (DuckDuckGo): _gaq and _gat, queued functions and hitCallback run', function () {
  var seen = [];
  var win = run('ga.js', { _gaq: [['_setAccount', 'UA-1'], function () { seen.push('fn'); }] });
  assert.deepEqual(seen, ['fn']);
  win._gaq.push(['_set', 'hitCallback', function () { seen.push('hit'); }]);
  assert.deepEqual(seen, ['fn', 'hit']);
  assert.equal(typeof win._gat._getTracker('UA-1')._trackPageview, 'function', 'unknown tracker methods are no-ops');
  assert.equal(win._gat._getTracker('UA-1')._getLinkerUrl('https://a.example/'), 'https://a.example/');
});

test('gtm.js: GTM eventCallback and gtag event_callback / get callbacks fire, dataLayer stays an array', function () {
  var seen = [];
  function gtagArgs() { return arguments; }
  var hidden = { end: function () { seen.push('anti-flicker end'); } };
  var dl = [{ 'gtm.start': 1, event: 'gtm.js' }, { event: 'early', eventCallback: function () { seen.push('early'); } },
    gtagArgs('event', 'conversion', { send_to: 'AW-1/x', event_callback: function () { seen.push('conversion'); } })];
  dl.hide = hidden;
  var win = run('gtm.js', { dataLayer: dl });
  assert.equal(win.dataLayer, dl, 'same array object');
  assert.deepEqual(seen, ['anti-flicker end'], 'anti-flicker released at once');
  assert.equal(dl.hide.end, null);
  var n = win.dataLayer.push({ event: 'click', eventCallback: function () { seen.push('click'); }, eventTimeout: 2000 });
  assert.equal(n, 4, 'push still appends and returns the new length');
  win.dataLayer.push(gtagArgs('get', 'G-1', 'client_id', function (v) { seen.push('get ' + v); }));
  win.dataLayer.push(gtagArgs('config', 'G-1'), gtagArgs('event', 'page_view'), null, 'x');
  __advanceTimers(10);
  assert.deepEqual(seen, ['anti-flicker end', 'early', 'conversion', 'click', 'get undefined']);
  assert.equal(win.dataLayer.length, 9);
  // gtm.js and gtag/js on one page: the second copy must not hook again (no double callbacks)
  run('gtm.js', win);
  win.dataLayer.push({ eventCallback: function () { seen.push('once'); } });
  __advanceTimers(10);
  assert.equal(seen.filter(function (x) { return x === 'once'; }).length, 1);
  var fresh = run('gtm.js', {});
  assert.ok(Array.isArray(fresh.dataLayer), 'creates dataLayer when the page has none');
});

test('gpt.js (DuckDuckGo, guarded): googletag.cmd runs queued and later functions on no-op slots', function () {
  var seen = [];
  var win = run('gpt.js', { googletag: { cmd: [function () { seen.push('queued'); }] } });
  var gt = win.googletag;
  assert.deepEqual(seen, ['queued']);
  assert.equal(gt.apiReady, true);
  gt.cmd.push(function () {
    var slot = gt.defineSlot('/1/x', [300, 250], 'div-1').addService(gt.pubads());
    gt.pubads().enableSingleRequest();
    gt.pubads().setTargeting('k', 'v');
    gt.enableServices();
    gt.display('div-1');
    seen.push(typeof slot.getSlotElementId() + ' ' + gt.pubads().getTargeting('k')[0]);
  });
  assert.deepEqual(seen, ['queued', 'string v']);
  var noCmd = run('gpt.js', { googletag: {} });
  assert.equal(typeof noCmd.googletag.cmd.push, 'function', 'a googletag object without cmd no longer throws');
});

test('adsbygoogle.js: loaded flag, queue replayed, Ad Placement API callbacks fire', function () {
  var seen = [];
  var win = run('adsbygoogle.js', { adsbygoogle: [{}, { preloadAdBreaks: 'on', onReady: function () { seen.push('ready'); } }] });
  assert.equal(win.adsbygoogle.loaded, true);
  assert.equal(typeof win.adsbygoogle.push, 'function');
  win.adsbygoogle.push({ type: 'reward', name: 'r1', beforeReward: function () { seen.push('never'); },
    adBreakDone: function (info) { seen.push(info.breakType + ' ' + info.breakName + ' ' + info.breakStatus); } });
  win.adsbygoogle.push({});
  win.adsbygoogle.push(null);
  __advanceTimers(10);
  assert.deepEqual(seen, ['ready', 'reward r1 notReady']);
  var again = { adsbygoogle: win.adsbygoogle };
  run('adsbygoogle.js', again);
  assert.equal(again.adsbygoogle, win.adsbygoogle, 'a second copy keeps the first');
});

test('ima3.js: google.ima API present; requestAds ends in AD_ERROR so the player plays content', function () {
  var win = run('ima3.js', { google: { maps: 1 } });
  var ima = win.google.ima;
  assert.equal(win.google.maps, 1, 'other google.* namespaces kept');
  ['AdDisplayContainer', 'AdsLoader', 'AdsRequest', 'AdsRenderingSettings', 'AdsManagerLoadedEvent', 'AdErrorEvent', 'AdEvent', 'AdError',
    'CompanionAdSelectionSettings', 'ImaSdkSettings'].forEach(function (k) { assert.equal(typeof ima[k], 'function', k); });
  assert.equal(ima.AdErrorEvent.Type.AD_ERROR, 'adError');
  assert.equal(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, 'adsManagerLoaded');
  assert.equal(ima.AdEvent.Type.CONTENT_RESUME_REQUESTED, 'contentResumeRequested');
  ima.settings.setVpaidMode(ima.ImaSdkSettings.VpaidMode.ENABLED);
  assert.equal(ima.settings.getVpaidMode(), 1);
  ima.settings.setSomethingNew('x');
  assert.equal(ima.settings.then, undefined, 'never thenable');
  var adc = new ima.AdDisplayContainer({}, {});
  adc.initialize();
  var loader = new ima.AdsLoader(adc);
  assert.ok(loader instanceof ima.AdsLoader);
  var seen = [];
  var ctx = { id: 7 };
  loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, function () { seen.push('manager'); }, false);
  var req = new ima.AdsRequest();
  req.adTagUrl = 'https://ads.example/vast';
  req.setAdWillAutoPlay(true);
  req.setUnknownOption(1);
  loader.requestAds(req, ctx);
  var scope = {};
  loader.addEventListener([ima.AdErrorEvent.Type.AD_ERROR], function (e) {
    seen.push(e.getError().getErrorCode() + ' ' + e.getError().getType() + ' ' + (e.getUserRequestContext() === ctx) + ' ' + (this === scope));
  }, false, scope);
  assert.deepEqual(seen, [], 'asynchronous, so listeners added right after requestAds still hear it');
  __advanceTimers(10);
  assert.deepEqual(seen, ['1009 adLoadError true true']);
  assert.equal(ima.AdError.ErrorCode.VAST_EMPTY_RESPONSE, 1009);
  var mgr = new ima.AdsManagerLoadedEvent().getAdsManager({}, new ima.AdsRenderingSettings());
  var done = [];
  mgr.addEventListener(ima.AdEvent.Type.ALL_ADS_COMPLETED, function () { done.push('all'); });
  mgr.init(640, 360, ima.ViewMode.NORMAL);
  mgr.start();
  __advanceTimers(10);
  assert.deepEqual(done, ['all']);
  assert.equal(loader.getSettings(), ima.settings);
  var real = { google: { ima: { AdsLoader: function RealLoader() {} } } };
  var kept = real.google.ima;
  run('ima3.js', real);
  assert.equal(real.google.ima, kept, 'a real SDK already on the page is left alone');
});
