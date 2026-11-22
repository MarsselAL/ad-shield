/*
 * ISOLATED world: cosmetic module and bridge against browser stubs. Switching the extension
 * off must undo the cosmetic DOM changes, hide/suppress the toast and stop forwarding events.
 */
load('tests/lib/browser-stubs.js');
var env = installBrowserStubs({ chrome: true });
loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/blocking.js', 'src/shared/logger.js', 'src/shared/frame.js',
  'src/shared/stats.js', 'src/content/cosmetic.js');
var ns = __TAS__;
var cfg = ns.config;
var S = ns.settings;
var quietLog = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function adVideo(displayBefore) {
  var v = env.el('video');
  v.currentSrc = 'https://m.media-amazon.com/ad.mp4';
  v.paused = false;
  v.muted = false;
  v.pause = function () { v.paused = true; };
  if (displayBefore) v.style.setProperty('display', displayBefore, '');
  return v;
}

function makeDoc(videos) {
  var doc = Object.create(document);
  doc.head = env.el('head');
  doc.getElementsByTagName = function (t) { return t === 'video' ? videos : []; };
  return doc;
}

test('cosmetic: enabled hides ad videos; disabled removes CSS and restores their display', function () {
  var plain = adVideo(), styled = adVideo('block');
  var doc = makeDoc([plain, styled]);
  var hiddenCount = 0;
  var c = ns.cosmetic.createCosmetic({ doc: doc, log: quietLog, onHidden: function () { hiddenCount++; } });
  c.setEnabled(true);
  assert.equal(doc.head.children.length, 1, 'style rule added');
  c.scan();
  assert.equal(hiddenCount, 2);
  assert.equal(plain.style.props.display, 'none');
  assert.equal(styled.style.prio.display, 'important');
  assert.ok(plain.muted && plain.paused);

  c.setEnabled(false);
  assert.equal(doc.head.children.length, 0, 'style rule removed');
  assert.equal(plain.style.props.display, undefined, 'inline display removed');
  assert.equal(styled.style.props.display, 'block', 'previous inline display restored');
  assert.equal(styled.style.prio.display, '');
  c.scan();
  assert.equal(hiddenCount, 2, 'scan does nothing while disabled');

  c.setEnabled(true);
  c.scan();
  assert.equal(plain.style.props.display, 'none', 'hidden again after re-enabling');
});

test('cosmetic: display ads beside the player hidden by CSS, their videos muted; the player wrapper never touched', function () {
  var cc = cfg.cosmetic;
  var DISPLAY = cc.displayAdSelectors.join(', ');
  function plainVideo(name) {
    var v = adVideo();
    v.currentSrc = 'blob:https://www.twitch.tv/' + name;
    return v;
  }
  function box(tag, videos, holdsPlayer) {
    var b = env.el(tag);
    b.matches = function (sel) { return sel !== cc.playerAreaSelector; };
    b.querySelector = function (sel) { return sel === cc.playerAreaSelector && holdsPlayer ? env.el('div') : null; };
    b.getElementsByTagName = function (t) { return t === 'video' ? videos : []; };
    return b;
  }
  var adV = plainVideo('display-ad');
  var mainV = plainVideo('stream');
  var frameV = plainVideo('frame-ad');
  var banner = box('div', [adV], false);
  var wrapper = box('div', [mainV], true);            // .stream-display-ad around the player
  var frame = box('iframe', [], false);
  frame.contentDocument = { getElementsByTagName: function (t) { return t === 'video' ? [frameV] : []; } };
  var xo = box('iframe', [], false);
  Object.defineProperty(xo, 'contentDocument', { get: function () { throw new Error('SecurityError'); } });
  var doc = makeDoc([]);
  doc.querySelectorAll = function (sel) { return sel === DISPLAY ? [banner, wrapper, frame, xo] : []; };
  var hidden = 0;
  var c = ns.cosmetic.createCosmetic({ doc: doc, log: quietLog, onHidden: function () { hidden++; } });
  c.setEnabled(true);
  var css = doc.head.children[0].textContent;
  cc.displayAdSelectors.forEach(function (sel) {
    assert.includes(css, sel + ':not(.video-player):not([data-a-target="video-player"]):not(:has(' + cc.playerAreaSelector + ')) { display: none !important; }');
  });
  ['[data-test-selector="display-ad"]', '[data-test-selector="ad-banner"]', '[data-a-target="ads-banner"]',
    'iframe[title="Stream Display Ad"]', '.stream-display-ad'].forEach(function (sel) { assert.ok(cc.displayAdSelectors.indexOf(sel) !== -1, sel); });
  c.scan();
  assert.ok(adV.muted && adV.paused, 'video in a display ad muted and paused');
  assert.ok(frameV.muted && frameV.paused, 'video in a same-origin ad iframe muted and paused');
  assert.notOk(mainV.muted || mainV.paused, 'the stream inside a .stream-display-ad wrapper is never touched');
  assert.equal(mainV.style.props.display, undefined);
  assert.equal(hidden, 2);
  // inDisplayAd: what the play listener uses for a video that starts later
  var lateV = plainVideo('late');
  lateV.closest = function (sel) { return sel === DISPLAY ? banner : null; };
  assert.ok(ns.cosmetic.inDisplayAd(lateV), 'inside a display ad');
  var streamV = plainVideo('stream2');
  streamV.closest = function (sel) { return sel === DISPLAY ? wrapper : null; };
  assert.notOk(ns.cosmetic.inDisplayAd(streamV), 'inside the player wrapper: not an ad');
  var inPlayer = plainVideo('stream3');
  inPlayer.closest = function (sel) { return sel === DISPLAY ? banner : (sel === cc.playerAreaSelector ? env.el('div') : null); };
  assert.notOk(ns.cosmetic.inDisplayAd(inPlayer), 'inside the player area: not an ad');
  c.setEnabled(false);
  assert.equal(adV.style.props.display, undefined, 'display restored when switched off');
});

test('bridge: settings go to the page only once storage answered; off = no toast, no events', function () {
  var stored = S.defaults();
  env.stored[S.STORAGE_KEY] = stored;
  // A player container for the toast.
  var player = env.el('div');
  document.querySelector = function (sel) { return sel === cfg.player.playerContainerSelector ? player : null; };
  load('src/content/bridge.js');
  var toPageMsgs = function () { return env.messages(cfg.events.toPage).filter(function (m) { return m.type === 'settings'; }); };
  // The page says hello before chrome.storage has answered: no default settings are sent.
  env.toBridge(cfg, { type: 'hello', version: cfg.version, top: true, degraded: [] });
  assert.equal(toPageMsgs().length, 0, 'no settings before storage answered');
  return Promise.resolve().then(function () {}).then(function () {
    assert.equal(toPageMsgs().length, 1, 'stored settings sent');

    env.toBridge(cfg, { type: 'event', name: 'ad-blocked-backup', data: { channel: 'c' } });
    assert.equal(player.children.length, 1, 'toast shown while enabled');
    var sentBefore = env.sentToBackground.length;
    assert.ok(env.sentToBackground.some(function (m) { return m.type === 'tab-event' && m.name === 'ad-blocked-backup'; }));

    var off = S.defaults();
    off.enabled = false;
    env.changeStorage(S.STORAGE_KEY, off);
    var last = toPageMsgs()[toPageMsgs().length - 1];
    assert.equal(last.settings.enabled, false, 'page told');
    assert.equal(player.children.length, 0, 'visible toast removed');

    env.toBridge(cfg, { type: 'event', name: 'ad-stripped', data: { channel: 'c' } });
    assert.equal(player.children.length, 0, 'no toast while disabled');
    assert.equal(env.sentToBackground.length, sentBefore, 'no events forwarded while disabled');
  });
});

test('bridge: a site on the general allowlist is treated as switched off for the page', function () {
  var toPageMsgs = function () { return env.messages(cfg.events.toPage).filter(function (m) { return m.type === 'settings'; }); };
  env.changeStorage(S.STORAGE_KEY, S.defaults());
  assert.equal(toPageMsgs()[toPageMsgs().length - 1].settings.enabled, true);
  env.changeStorage('blocking', { allowlist: ['twitch.tv'] });
  assert.equal(toPageMsgs()[toPageMsgs().length - 1].settings.enabled, false, 'allowlisted: page told off');
  env.changeStorage('blocking', { allowlist: ['other.com'] });
  assert.equal(toPageMsgs()[toPageMsgs().length - 1].settings.enabled, true, 'removed from the list: on again');
});
