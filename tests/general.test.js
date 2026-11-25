/*
 * Background part of the general blocker (src/background/general.js) against a fake chrome.*,
 * the real generated data in rules/ and the vendored autoconsent library; and the small page
 * script (src/content/general.js) against browser stubs.
 */
globalThis.self = globalThis;
globalThis.console = globalThis.console || { log: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 60; i++) p = p.then(function () {});
  return p;
}

var BASE = 'chrome-extension://test-id/';
var manifest = JSON.parse(readFile('manifest.json'));
var calls = { rulesets: [], dynamic: [], registered: [], unregistered: [], css: [], exec: [], toTabs: [], actionOptions: [] };
var local = {}, session = {}, registered = [], dynamicRules = [], failDynamic = false;
var storageListeners = [], messageListeners = [];

function area(store, name) {
  return {
    get: function (keys) {
      var o = {};
      [].concat(keys).forEach(function (k) { if (store[k] !== undefined) o[k] = JSON.parse(JSON.stringify(store[k])); });
      return Promise.resolve(o);
    },
    set: function (o) {
      var ch = {};
      Object.keys(o).forEach(function (k) { ch[k] = { oldValue: store[k], newValue: o[k] }; store[k] = JSON.parse(JSON.stringify(o[k])); });
      storageListeners.forEach(function (fn) { fn(ch, name); });
      return Promise.resolve();
    },
    remove: function (k) { [].concat(k).forEach(function (x) { delete store[x]; }); return Promise.resolve(); },
    clear: function () { Object.keys(store).forEach(function (k) { delete store[k]; }); return Promise.resolve(); }
  };
}

globalThis.chrome = {
  runtime: {
    id: 'test-id',
    getManifest: function () { return manifest; },
    getURL: function (p) { return BASE + p; },
    onMessage: { addListener: function (fn) { messageListeners.push(fn); } },
    onInstalled: { addListener: function () {} },
    onStartup: { addListener: function () {} }
  },
  storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: { addListener: function (fn) { storageListeners.push(fn); } } },
  declarativeNetRequest: {
    updateEnabledRulesets: function (o) { calls.rulesets.push(o); return Promise.resolve(); },
    updateDynamicRules: function (o) {
      calls.dynamic.push(o);
      if (failDynamic && o.addRules.some(function (r) { return r.id > 1; })) return Promise.reject(new Error('quota'));
      dynamicRules = dynamicRules.filter(function (r) { return o.removeRuleIds.indexOf(r.id) === -1; }).concat(o.addRules);
      return Promise.resolve();
    },
    getDynamicRules: function () { return Promise.resolve(dynamicRules.slice()); },
    setExtensionActionOptions: function (o) { calls.actionOptions.push(o); return Promise.resolve(); }
  },
  scripting: {
    getRegisteredContentScripts: function () { return Promise.resolve(registered.map(function (s) { return { id: s.id }; })); },
    registerContentScripts: function (list) {
      list.forEach(function (s) { registered.push(s); calls.registered.push(s.id); });
      return Promise.resolve();
    },
    unregisterContentScripts: function (o) {
      registered = registered.filter(function (s) { return o.ids.indexOf(s.id) === -1; });
      calls.unregistered = calls.unregistered.concat(o.ids);
      return Promise.resolve();
    },
    insertCSS: function (o) { calls.css.push(o); return Promise.resolve(); },
    executeScript: function (o) { calls.exec.push(o); return Promise.resolve([{ result: 'snippet-result' }]); }
  },
  tabs: {
    sendMessage: function (tabId, msg, opts) { calls.toTabs.push({ tabId: tabId, msg: msg, frameId: opts && opts.frameId }); return Promise.resolve(); },
    onRemoved: { addListener: function () {} }
  }
};
var fetched = [];
globalThis.fetch = function (url) {
  var path = String(url).replace(BASE, '');
  fetched.push(path);
  return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(readFile(path))); } });
};

loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/logger.js', 'src/shared/blocking.js', 'src/shared/userfilters.js', 'src/shared/lists.js',
  'src/background/autoconsent-shim.js', 'vendor/autoconsent/autoconsent.cjs.js', 'src/background/general.js');
var B = __TAS__.blocking;
// The whole packaged site data, merged from rules/cosmetic/site/ (index + shards).
var SITE = (function () {
  var index = JSON.parse(readFile('rules/cosmetic/site/index.json'));
  var site = { v: 1, ads: {}, cookies: {}, exceptions: {} };
  for (var i = 0; i < index.n; i++) {
    var sh = JSON.parse(readFile('rules/cosmetic/site/' + B.siteShardName(i) + '.json'));
    ['ads', 'cookies', 'exceptions'].forEach(function (k) { Object.assign(site[k], sh[k]); });
  }
  ['genericExceptionHosts', 'generichide', 'elemhide', 'genericFullHosts'].forEach(function (k) { site[k] = index[k]; });
  return site;
})();
var EXCEPTED = JSON.parse(readFile('rules/cosmetic/generic_excepted.json'));

function send(msg, sender) {
  var response;
  var s = Object.assign({ id: 'test-id', frameId: 0, tab: { id: 7, url: 'https://www.1news.co.nz/' }, url: 'https://www.1news.co.nz/' }, sender || {});
  messageListeners.forEach(function (fn) { fn(msg, s, function (r) { response = r; }); });
  return flush().then(function () { return response; });
}
function ids() { return registered.map(function (s) { return s.id; }).sort(); }
function setBlocking(patch) { return chrome.storage.local.set({ blocking: Object.assign(B.normalize(local.blocking), patch) }).then(flush); }

test('startup: enables the generated rulesets, registers CSS and page script, badge count on', function () {
  return flush().then(function () {
    var last = calls.rulesets[calls.rulesets.length - 1];
    assert.deepEqual(last.enableRulesetIds.slice().sort(), ['ads_1', 'ads_curated', 'cookie_strip', 'cookies_1', 'privacy_1', 'privacy_curated', 'removeparam', 'gpc', 'youtube', 'ads_surrogates', 'privacy_surrogates'].sort());
    assert.deepEqual(last.disableRulesetIds, []);
    assert.deepEqual(ids(), ['as-css-ads', 'as-css-ads-exc', 'as-css-ads-top', 'as-css-cookies', 'as-css-cookies-exc', 'as-css-youtube', 'as-gpc', 'as-scriptlets', 'as-site']);
    var sl = registered.filter(function (s) { return s.id === 'as-scriptlets'; })[0];
    assert.equal(sl.world, 'MAIN');
    assert.deepEqual(sl.matches, ['*://*.m.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtube.com/*', '*://*.youtubekids.com/*'], 'hosts from rules/scriptlets.json (m. is redundant with *.youtube.com)');
    var css = registered.filter(function (s) { return s.id === 'as-css-ads'; })[0];
    var exc = registered.filter(function (s) { return s.id === 'as-css-ads-exc'; })[0];
    assert.ok(exc.excludeMatches.length >= SITE.genericExceptionHosts.length, 'exception hosts excluded from the excepted selectors');
    assert.ok(css.excludeMatches.length < SITE.genericExceptionHosts.length, 'but not from the big generic files');
    assert.ok(fetched.indexOf('rules/cosmetic/site/index.json') !== -1, 'registration reads the small index');
    assert.equal(fetched.filter(function (p) { return /generic\.json|site\/[0-9a-f]{2}\.json/.test(p); }).length, 0, 'no shard, no generic list at startup');
    assert.deepEqual(calls.actionOptions[0], { displayActionCountAsBadgeText: true });
    assert.deepEqual(calls.dynamic[calls.dynamic.length - 1], { removeRuleIds: [1], addRules: [] });
  });
});

test('same settings again: no re-registration', function () {
  var before = calls.registered.length;
  return __TAS__.general.apply().then(flush).then(function () {
    assert.equal(calls.registered.length, before);
  });
});

test('auto-reject on registers autoconsent; allowlist adds the dynamic rule and exclusions', function () {
  return setBlocking({ autoRejectCookies: true, allowlist: ['off.example'] }).then(function () {
    assert.deepEqual(ids(), ['as-autoconsent', 'as-css-ads', 'as-css-ads-exc', 'as-css-ads-top', 'as-css-cookies', 'as-css-cookies-exc', 'as-css-youtube', 'as-gpc', 'as-scriptlets', 'as-site']);
    var ac = registered.filter(function (s) { return s.id === 'as-autoconsent'; })[0];
    assert.deepEqual(ac.js, ['vendor/autoconsent/content.bundle.js']);
    assert.deepEqual(ac.excludeMatches, ['*://*.off.example/*']);
    var dyn = calls.dynamic[calls.dynamic.length - 1];
    assert.equal(dyn.addRules[0].action.type, 'allowAllRequests');
    assert.deepEqual(dyn.addRules[0].condition.requestDomains, ['off.example']);
  });
});

test('page hello: site CSS injected as USER origin into the sending frame, cookie selectors returned', function () {
  var host = '1news.co.nz';
  fetched = [];
  return send({ type: 'as-page', host: 'www.' + host, t: 1234 }).then(function (resp) {
    assert.deepEqual(fetched, ['rules/cosmetic/site/' + B.siteShardName(B.siteShard(host)) + '.json'], 'one shard read');
    var c = calls.css[calls.css.length - 1];
    assert.equal(c.origin, 'USER');
    assert.deepEqual(c.target, { tabId: 7, frameIds: [0] });
    assert.includes(c.css, SITE.ads[host][0] + '{display:none!important}');
    assert.deepEqual(resp.cookieSelectors.slice(0, 1), [SITE.cookies[host][0]]);
    assert.deepEqual(session['page:7'], { t: 1234, hidden: 0, rejected: 0 });
  });
});

test('page hello on an exception host: generic CSS injected minus the exceptions', function () {
  var host = SITE.genericExceptionHosts[0];
  var before = calls.css.length;
  fetched = [];
  return send({ type: 'as-page', host: host, t: 1 }, { tab: { id: 8, url: 'https://' + host + '/' } }).then(function () {
    assert.equal(calls.css.length, before + 1);
    assert.equal(fetched.indexOf('rules/cosmetic/generic.json'), -1, 'not the whole generic list');
    assert.ok(fetched.indexOf('rules/cosmetic/generic_excepted.json') !== -1);
    var css = calls.css[calls.css.length - 1].css;
    var lines = '\n' + css + '\n';
    var kept = EXCEPTED.ads.concat(EXCEPTED.cookies).filter(function (s) { return SITE.exceptions[host].indexOf(s) === -1; });
    assert.ok(kept.length > 100);
    kept.forEach(function (s) { assert.includes(lines, '\n' + s + '{', 'excepted elsewhere, hidden here: ' + s); });
    SITE.exceptions[host].forEach(function (s) { assert.notIncludes(lines, '\n' + s + '{', 'exception ' + s); });
  });
});

test('allowlisted page: nothing injected', function () {
  var before = calls.css.length;
  return send({ type: 'as-page', host: 'www.1news.co.nz', t: 1 }, { tab: { id: 9, url: 'https://shop.off.example/' } }).then(function (resp) {
    assert.equal(calls.css.length, before);
    assert.deepEqual(resp, { cookieSelectors: [] });
  });
});

test('banner hidden report counts for the page', function () {
  return send({ type: 'as-banner' }).then(function () {
    assert.equal(session['page:7'].hidden, 1);
  });
});

test('autoconsent init: compact rules and an opt-out config sent to the frame', function () {
  // Top frame: the site-independent rules apply. A sub frame gets the same config but only the
  // rules marked for frames (filterCompactRules with mainFrame false), so never more. Since
  // autoconsent 18 no generic rule targets sub frames, so that list may be empty.
  var top;
  calls.toTabs = [];
  return send({ type: 'init', url: 'https://www.1news.co.nz/' }).then(function () {
    top = calls.toTabs[0];
    assert.equal(top.frameId, 0);
    assert.equal(top.msg.type, 'initResp');
    assert.equal(top.msg.config.enabled, true);
    assert.equal(top.msg.config.autoAction, 'optOut');
    assert.ok(top.msg.rules.compact && top.msg.rules.compact.r.length > 0, 'compact rules');
    calls.toTabs = [];
    return send({ type: 'init', url: 'https://www.1news.co.nz/' }, { frameId: 3 });
  }).then(function () {
    var m = calls.toTabs[0];
    assert.equal(m.frameId, 3);
    assert.equal(m.msg.type, 'initResp');
    assert.equal(m.msg.config.enabled, true);
    assert.equal(m.msg.config.autoAction, 'optOut');
    assert.ok(m.msg.rules.compact && Array.isArray(m.msg.rules.compact.r), 'compact rules for the frame');
    assert.ok(m.msg.rules.compact.r.length < top.msg.rules.compact.r.length, 'sub frame gets the frame-filtered subset');
  });
});

test('autoconsent eval: runs the named snippet in the MAIN world and answers with evalResp', function () {
  var name = Object.keys(self.module.exports.evalSnippets)[0];
  calls.toTabs = [];
  return send({ type: 'eval', id: 'e1', code: '', snippetId: name }, { frameId: 2 }).then(function () {
    var e = calls.exec[calls.exec.length - 1];
    assert.equal(e.world, 'MAIN');
    assert.deepEqual(e.target, { tabId: 7, frameIds: [2] });
    assert.equal(e.func, self.module.exports.evalSnippets[name]);
    assert.deepEqual(calls.toTabs[0].msg, { type: 'evalResp', id: 'e1', result: 'snippet-result' });
    return send({ type: 'eval', id: 'e2', snippetId: 'no-such-snippet' });
  }).then(function () {
    assert.deepEqual(calls.toTabs[calls.toTabs.length - 1].msg, { type: 'evalResp', id: 'e2', result: false });
  });
});

test('autoconsentDone counts a rejected banner', function () {
  return send({ type: 'autoconsentDone', cmp: 'x', isCosmetic: false, url: '' }).then(function () {
    assert.equal(session['page:7'].rejected, 1);
  });
});

test('auto-reject off: init answers enabled=false and the script is unregistered', function () {
  calls.toTabs = [];
  return setBlocking({ autoRejectCookies: false }).then(function () {
    assert.equal(ids().indexOf('as-autoconsent'), -1);
    return send({ type: 'init', url: 'https://a.com/' });
  }).then(function () {
    assert.equal(calls.toTabs[0].msg.config.enabled, false);
  });
});

test('master switch off: all general rulesets disabled, scripts unregistered, allowlist rule removed', function () {
  return chrome.storage.local.set({ settings: Object.assign(__TAS__.settings.defaults(), { enabled: false }) }).then(flush).then(function () {
    var last = calls.rulesets[calls.rulesets.length - 1];
    assert.deepEqual(last.enableRulesetIds, []);
    assert.equal(last.disableRulesetIds.length, 11, 'including gpc and the two surrogate rulesets');
    assert.deepEqual(ids(), []);
    assert.deepEqual(calls.dynamic[calls.dynamic.length - 1].addRules, []);
  });
});

test('messages from other extensions or without a tab are ignored', function () {
  var before = calls.css.length;
  return send({ type: 'as-page', host: 'www.1news.co.nz' }, { id: 'other' }).then(function () {
    return send({ type: 'as-page', host: 'www.1news.co.nz' }, { tab: undefined });
  }).then(function () {
    assert.equal(calls.css.length, before);
  });
});

// ------------------------------------------------------------------ element picker / My filters
test('picker save: stored under the site key, CSS inserted into the top frame at once', function () {
  var before = calls.css.length;
  return send({ type: 'as-picker-save', selector: '.while-off' }).then(function (resp) {
    assert.ok(resp.ok, 'master switch off: stored');
    assert.equal(calls.css.length, before, 'master switch off: nothing inserted');
    return chrome.storage.local.set({ settings: __TAS__.settings.defaults(), userFilters: {} }).then(flush);
  }).then(function () {
    return send({ type: 'as-picker-save', selector: ' .my-ad ' });
  }).then(function (resp) {
    assert.deepEqual(resp, { ok: true, error: null });
    assert.deepEqual(local.userFilters, { '1news.co.nz': ['.my-ad'] }, 'site taken from the tab URL, www. dropped');
    assert.equal(calls.css.length, before + 1);
    assert.deepEqual(calls.css[calls.css.length - 1], { target: { tabId: 7, frameIds: [0] }, css: '.my-ad{display:none!important}', origin: 'USER' });
    return send({ type: 'as-picker-save', selector: '.my-ad' });
  }).then(function (resp) {
    assert.ok(resp.ok, 'saving the same selector again is fine');
    assert.deepEqual(local.userFilters, { '1news.co.nz': ['.my-ad'] });
  });
});

test('picker save: bad selector, sub frame or allowlisted site', function () {
  var before = calls.css.length;
  return send({ type: 'as-picker-save', selector: 'div{color:red}' }).then(function (resp) {
    assert.equal(resp.ok, false);
    assert.includes(resp.error, 'Selector');
    return send({ type: 'as-picker-save', selector: '.x' }, { frameId: 3 });
  }).then(function (resp) {
    assert.equal(resp.ok, false);
    return send({ type: 'as-picker-save', selector: '.y' }, { tab: { id: 9, url: 'https://shop.off.example/' } });
  }).then(function (resp) {
    assert.ok(resp.ok, 'stored on an allowlisted site');
    assert.deepEqual(local.userFilters['shop.off.example'], ['.y']);
    assert.equal(calls.css.length, before, 'nothing inserted: bad selector, sub frame, allowlisted site');
    return chrome.storage.local.set({ userFilters: { '1news.co.nz': ['.my-ad'] } }).then(flush);
  });
});

test('page hello: My filters added to the site CSS; with Ads and Cookie banners off only they apply', function () {
  return send({ type: 'as-page', host: 'www.1news.co.nz', t: 5 }).then(function () {
    var css = calls.css[calls.css.length - 1].css;
    assert.includes(css, SITE.ads['1news.co.nz'][0] + '{display:none!important}');
    assert.includes(css, '\n.my-ad{display:none!important}');
    return setBlocking({ ads: false, hideCookieBanners: false });
  }).then(function () {
    var site = registered.filter(function (s) { return s.id === 'as-site'; })[0];
    assert.deepEqual(site.matches, ['*://*.1news.co.nz/*'], 'page script only where My filters exist');
    return send({ type: 'as-page', host: 'www.1news.co.nz', t: 6 });
  }).then(function (resp) {
    assert.equal(calls.css[calls.css.length - 1].css, '.my-ad{display:none!important}');
    assert.deepEqual(resp, { cookieSelectors: [] });
    return chrome.storage.local.set({ userFilters: {} }).then(flush);
  }).then(function () {
    assert.equal(ids().indexOf('as-site'), -1, 'no filters left: page script unregistered');
    return setBlocking({ ads: true, hideCookieBanners: true });
  }).then(function () {
    assert.ok(ids().indexOf('as-site') !== -1);
  });
});

// ------------------------------------------------------------------ updated lists (dynamic rules)
function dynRule(id) { return { id: id, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['d' + id + '.example'] } }; }
function dynIds(f) { return dynamicRules.filter(function (r) { return B.dynamicFeature(r.id) === f; }).map(function (r) { return r.id; }); }
function lastPlan() { return calls.rulesets[calls.rulesets.length - 1]; }
var STORED = { ads: [dynRule(1000001), dynRule(1500001)], trackers: [dynRule(2000001)], hideCookieBanners: [dynRule(3000001)] };
var META = { source: 'updated', lastCheck: 1, lists: {} };

test('installLists: dynamic rules in one call, list rulesets off, curated / cookie_strip stay on, then stored', function () {
  return chrome.storage.local.set({ settings: __TAS__.settings.defaults(), blocking: B.defaults() }).then(flush).then(function () {
    var before = calls.dynamic.length;
    return __TAS__.general.installLists({ rules: STORED, site: Object.assign({}, SITE, { ads: { 'fresh.example': ['.fresh-ad'] } }), meta: META }).then(function (res) {
      assert.ok(res.ok);
      var adding = calls.dynamic.slice(before).filter(function (c) { return c.addRules.length > 1; });
      assert.equal(adding.length, 1, 'one atomic updateDynamicRules');
      assert.deepEqual(dynIds('ads'), [1000001, 1500001]);
      assert.deepEqual(dynIds('trackers'), [2000001]);
      var p = lastPlan();
      assert.deepEqual(p.disableRulesetIds.slice().sort(), ['ads_1', 'cookies_1', 'privacy_1']);
      assert.deepEqual(p.enableRulesetIds.slice().sort(), ['ads_curated', 'cookie_strip', 'privacy_curated', 'removeparam', 'gpc', 'youtube', 'ads_surrogates', 'privacy_surrogates'].sort());
      assert.deepEqual(local.listRules, STORED);
      assert.deepEqual(local.lists, META);
      assert.equal(local.listSite.v, 2, 'sharded marker');
      assert.deepEqual(local['listSite/index'].genericExceptionHosts, SITE.genericExceptionHosts);
      var shardKeys = Object.keys(local).filter(function (k) { return /^listSite\/[0-9a-f]{2}$/.test(k); });
      assert.equal(shardKeys.length, B.SITE_SHARDS);
      assert.deepEqual(local['listSite/' + B.siteShardName(B.siteShard('fresh.example'))].ads, { 'fresh.example': ['.fresh-ad'] });
    });
  });
});

test('page hello uses the updated site data from storage', function () {
  fetched = [];
  return send({ type: 'as-page', host: 'www.fresh.example', t: 5 }, { tab: { id: 11, url: 'https://www.fresh.example/' } }).then(function () {
    assert.includes(calls.css[calls.css.length - 1].css, '.fresh-ad{display:none!important}');
    assert.deepEqual(fetched, [], 'nothing read from the package');
  });
});

test('Trackers off removes only the tracker dynamic rules (and privacy_N stays off); on again re-adds them', function () {
  return setBlocking({ trackers: false }).then(function () {
    assert.deepEqual(dynIds('trackers'), []);
    assert.deepEqual(dynIds('ads'), [1000001, 1500001]);
    assert.ok(lastPlan().disableRulesetIds.indexOf('privacy_1') !== -1);
    return setBlocking({ trackers: true });
  }).then(function () {
    assert.deepEqual(dynIds('trackers'), [2000001]);
    assert.ok(lastPlan().disableRulesetIds.indexOf('privacy_1') !== -1, 'privacy_1 stays off: dynamic rules active');
  });
});

test('master switch off removes every dynamic list rule; on restores them from storage', function () {
  return chrome.storage.local.set({ settings: Object.assign(__TAS__.settings.defaults(), { enabled: false }) }).then(flush).then(function () {
    assert.equal(dynamicRules.length, 0);
    return chrome.storage.local.set({ settings: __TAS__.settings.defaults() }).then(flush);
  }).then(function () {
    assert.equal(dynamicRules.length, 4);
  });
});

test('Chrome refuses new rules: previous dynamic rules and storage kept, installLists rejects', function () {
  failDynamic = true;
  var other = { ads: [dynRule(1000009)], trackers: [], hideCookieBanners: [] };
  return __TAS__.general.installLists({ rules: other, site: SITE, meta: { source: 'updated', x: 1 } }).then(function () {
    throw new Error('should reject');
  }, function (e) {
    failDynamic = false;
    assert.includes(e.message, 'quota');
    assert.deepEqual(dynIds('ads'), [1000001, 1500001]);
    assert.deepEqual(local.listRules, STORED);
    assert.deepEqual(lastPlan().disableRulesetIds.slice().sort(), ['ads_1', 'cookies_1', 'privacy_1']);
  });
});

test('resetLists: static list rulesets enabled before the dynamic rules go, storage cleared', function () {
  var n = calls.rulesets.length;
  return __TAS__.general.resetLists({ source: 'packaged', lists: {} }).then(function () {
    assert.equal(dynamicRules.filter(function (r) { return r.id !== 1; }).length, 0);
    var first = calls.rulesets[n];
    assert.deepEqual(first.enableRulesetIds.slice().sort(), ['ads_1', 'ads_curated', 'cookie_strip', 'cookies_1', 'privacy_1', 'privacy_curated', 'removeparam', 'gpc', 'youtube', 'ads_surrogates', 'privacy_surrogates'].sort());
    assert.equal(local.listRules, undefined);
    assert.equal(local.listSite, undefined);
    assert.deepEqual(Object.keys(local).filter(function (k) { return k.indexOf('listSite') === 0; }), [], 'every shard removed');
    assert.equal(local.lists.source, 'packaged');
  });
});

test('site data stored whole by an older version is still used; its exception hosts get the whole generic list', function () {
  var host = SITE.genericExceptionHosts[0];
  var old = Object.assign({}, SITE, { ads: { 'legacy.example': ['.legacy-ad'] } });
  delete old.genericFullHosts;
  return chrome.storage.local.set({ listSite: old }).then(flush).then(function () {
    return send({ type: 'as-page', host: 'legacy.example', t: 6 }, { tab: { id: 12, url: 'https://legacy.example/' } });
  }).then(function () {
    assert.includes(calls.css[calls.css.length - 1].css, '.legacy-ad{display:none!important}');
    fetched = [];
    return send({ type: 'as-page', host: host, t: 7 }, { tab: { id: 13, url: 'https://' + host + '/' } });
  }).then(function () {
    assert.deepEqual(fetched, ['rules/cosmetic/generic.json']);
    assert.ok(calls.css[calls.css.length - 1].css.split('\n').length > 1000, 'whole generic list');
    return __TAS__.general.apply().then(flush);  // as after the extension update (onInstalled)
  }).then(function () {
    var exc = registered.filter(function (s) { return s.id === 'as-css-ads'; })[0];
    assert.ok(exc.excludeMatches.length >= SITE.genericExceptionHosts.length, 'and the big files skip them');
    return chrome.storage.local.remove('listSite');
  });
});

// ------------------------------------------------------------------ page script
test('page script: says hello once, checks the cookie selectors once after load', function () {
  var saved = globalThis.chrome;
  load('tests/lib/browser-stubs.js');
  var env = installBrowserStubs({ chrome: true });
  var sent = [];
  chrome.runtime.sendMessage = function (m) {
    sent.push(m);
    return Promise.resolve(m.type === 'as-page' ? { cookieSelectors: ['div[', '#consent'] } : undefined);
  };
  document.readyState = 'complete';
  document.querySelector = function (sel) {
    if (sel === 'div[') throw new Error('SyntaxError');
    return sel === '#consent' ? env.el('div') : null;
  };
  location.hostname = 'www.example.com';
  globalThis.performance = { timeOrigin: 1700000000123.7 };
  load('src/content/general.js');
  load('src/content/general.js');
  return flush().then(function () {
    assert.deepEqual(sent, [{ type: 'as-page', host: 'www.example.com', t: 1700000000123 }]);
    __advanceTimers(1500);
    return flush();
  }).then(function () {
    assert.deepEqual(sent.map(function (m) { return m.type; }), ['as-page', 'as-banner']);
    __advanceTimers(60000);
    assert.equal(sent.length, 2, 'no repeated checks');
    globalThis.chrome = saved;
  });
});
