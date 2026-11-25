/* General blocking settings, allowlist and planning functions (src/shared/blocking.js). */
loadSrc('src/config.js', 'src/shared/blocking.js');
var B = __TAS__.blocking;

test('defaults: everything on except auto-reject; normalize never throws', function () {
  var d = B.defaults();
  assert.deepEqual(d, { ads: true, trackers: true, stripCookies: true, hideCookieBanners: true, autoRejectCookies: false, autoUpdateLists: true, scriptlets: true, stripTrackingParams: true, gpc: true, allowlist: [] });
  assert.equal(B.normalize({ scriptlets: false }).scriptlets, false);
  assert.equal(B.normalize({ scriptlets: 1 }).scriptlets, true);
  assert.equal(B.normalize({ autoUpdateLists: false }).autoUpdateLists, false);
  assert.equal(B.normalize({ autoUpdateLists: 'no' }).autoUpdateLists, true);
  assert.deepEqual(B.normalize(null), d);
  assert.deepEqual(B.normalize('x'), d);
  var n = B.normalize({ ads: false, trackers: 'no', allowlist: ['B.com', 'b.com', 'bad host', 5, 'https://www.x.org/p'], extra: 1 });
  assert.equal(n.ads, false);
  assert.equal(n.trackers, true);
  assert.deepEqual(n.allowlist, ['b.com', 'www.x.org']);
  assert.equal(n.extra, undefined);
});

test('normalizeHost and siteKey', function () {
  assert.equal(B.normalizeHost('https://Sub.Example.com:8443/path?q#h'), 'sub.example.com');
  assert.equal(B.normalizeHost('*.example.com'), 'example.com');
  assert.equal(B.normalizeHost('example.com.'), 'example.com');
  assert.equal(B.normalizeHost('user@example.com'), 'example.com');
  assert.equal(B.normalizeHost(''), null);
  assert.equal(B.normalizeHost('exa mple.com'), null);
  assert.equal(B.normalizeHost('-bad.com'), null);
  assert.equal(B.siteKey('www.example.com'), 'example.com');
  assert.equal(B.siteKey('shop.example.com'), 'shop.example.com');
});

test('allowlist: covers subdomains only, popup switch adds and removes covering entries', function () {
  var l = ['example.com'];
  assert.ok(B.isAllowlisted('example.com', l));
  assert.ok(B.isAllowlisted('a.b.example.com', l));
  assert.notOk(B.isAllowlisted('notexample.com', l));
  assert.notOk(B.isAllowlisted('example.com.evil.net', l));
  assert.deepEqual(B.setSiteAllowed([], 'www.news.org', true), ['news.org']);
  assert.deepEqual(B.setSiteAllowed(['news.org'], 'www.news.org', true), ['news.org'], 'no duplicate');
  assert.deepEqual(B.setSiteAllowed(['news.org', 'other.net'], 'live.news.org', false), ['other.net']);
});

test('parseAllowlistText: lines, commas, errors', function () {
  var v = B.parseAllowlistText('example.com\n https://www.News.org/x , b.net\n\n');
  assert.ok(v.ok);
  assert.deepEqual(v.value, ['b.net', 'example.com', 'www.news.org']);
  var bad = B.parseAllowlistText('ok.com\nnot a site!');
  assert.notOk(bad.ok);
  assert.includes(bad.errors.join(' '), 'Not a valid site');
});

test('rulesetPlan: features map to generated rulesets, Twitch rulesets untouched, master off disables all', function () {
  var ids = ['client_ads', 'trackers', 'ads_1', 'ads_2', 'privacy_1', 'cookies_1', 'cookie_strip'];
  var b = Object.assign(B.defaults(), { trackers: false });
  var p = B.rulesetPlan(ids, true, b);
  assert.deepEqual(p.enableRulesetIds, ['ads_1', 'ads_2', 'cookies_1', 'cookie_strip']);
  assert.deepEqual(p.disableRulesetIds, ['privacy_1']);
  var off = B.rulesetPlan(ids, false, B.defaults());
  assert.deepEqual(off.enableRulesetIds, []);
  assert.equal(off.disableRulesetIds.length, 5);
});

test('rulesetPlan: curated rulesets follow the Ads / Trackers switches and the master switch', function () {
  var ids = ['client_ads', 'trackers', 'ads_1', 'ads_curated', 'privacy_1', 'privacy_curated', 'cookies_1', 'cookie_strip'];
  var all = B.rulesetPlan(ids, true, B.defaults());
  assert.deepEqual(all.enableRulesetIds, ['ads_1', 'ads_curated', 'privacy_1', 'privacy_curated', 'cookies_1', 'cookie_strip']);
  assert.deepEqual(all.disableRulesetIds, []);
  var noAds = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { ads: false }));
  assert.deepEqual(noAds.disableRulesetIds, ['ads_1', 'ads_curated']);
  var noTrackers = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { trackers: false }));
  assert.deepEqual(noTrackers.disableRulesetIds, ['privacy_1', 'privacy_curated']);
  var off = B.rulesetPlan(ids, false, B.defaults());
  assert.deepEqual(off.enableRulesetIds, []);
  assert.equal(off.disableRulesetIds.length, 6);
  assert.equal(B.rulesetFeature('ads_curated'), 'ads');
  assert.equal(B.rulesetFeature('privacy_curated'), 'trackers');
  assert.equal(B.rulesetFeature('cookies_curated'), null);
  assert.equal(B.rulesetFeature('ads_curated_1'), null);
  assert.equal(B.rulesetFeature('youtube'), 'ads', 'hand-written YouTube ruleset follows Ads');
  assert.notOk(B.isListRuleset('youtube'), 'not replaced by the weekly list update');
  var yt = B.rulesetPlan(['ads_1', 'youtube'], true, Object.assign(B.defaults(), { ads: false }));
  assert.deepEqual(yt.disableRulesetIds, ['ads_1', 'youtube']);
  assert.deepEqual(B.rulesetPlan(['ads_1', 'youtube'], true, B.defaults(), { ads: true }).enableRulesetIds, ['youtube']);
  assert.deepEqual(B.countMatches([{ rule: { rulesetId: 'youtube', ruleId: 1 } }]).ads, 1);
  assert.deepEqual(B.countMatches([{ rule: { rulesetId: 'youtube', ruleId: 2 } }]).ads, 1);
  // rule 3 adds pp=oAEBogYBLg to watch-page loads, 500001 is its loop guard (allow): nothing blocked
  assert.deepEqual(B.countMatches([{ rule: { rulesetId: 'youtube', ruleId: 3 } }, { rule: { rulesetId: 'youtube', ruleId: 500001 } }]),
    { ads: 0, trackers: 0, cookies: 0, banners: 0 }, 'pp redirect / allow not counted');
  assert.deepEqual(B.YOUTUBE_UNCOUNTED_RULE_IDS, [3]);
});

test('removeparam ruleset: own switch, never counted', function () {
  assert.equal(B.rulesetFeature('removeparam'), 'stripTrackingParams');
  assert.notOk(B.isListRuleset('removeparam'), 'the weekly update never replaces it');
  var ids = ['ads_1', 'removeparam'];
  assert.deepEqual(B.rulesetPlan(ids, true, B.defaults()).enableRulesetIds, ['ads_1', 'removeparam']);
  assert.deepEqual(B.rulesetPlan(ids, true, B.defaults(), { ads: true }).enableRulesetIds, ['removeparam'], 'dynamic lists do not disable it');
  var off = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { stripTrackingParams: false }));
  assert.deepEqual(off.enableRulesetIds, ['ads_1']);
  assert.deepEqual(off.disableRulesetIds, ['removeparam']);
  assert.deepEqual(B.rulesetPlan(ids, false, B.defaults()).enableRulesetIds, []);
  assert.equal(B.normalize({ stripTrackingParams: false }).stripTrackingParams, false);
  assert.equal(B.normalize({ stripTrackingParams: 'x' }).stripTrackingParams, true);
  assert.deepEqual(B.countMatches([{ rule: { rulesetId: 'removeparam', ruleId: 3 } }]), { ads: 0, trackers: 0, cookies: 0, banners: 0 });
});

test('gpc: own switch (default on, old settings migrate to on), static ruleset never counted', function () {
  assert.equal(B.defaults().gpc, true);
  assert.equal(B.normalize({ ads: true, allowlist: [] }).gpc, true, 'settings stored before GPC existed: on');
  assert.equal(B.normalize({ gpc: false }).gpc, false);
  assert.equal(B.normalize({ gpc: 'no' }).gpc, true);
  assert.equal(B.rulesetFeature('gpc'), 'gpc');
  assert.notOk(B.isListRuleset('gpc'), 'the weekly update never replaces it');
  var ids = ['ads_1', 'removeparam', 'gpc'];
  assert.deepEqual(B.rulesetPlan(ids, true, B.defaults()).enableRulesetIds, ['ads_1', 'removeparam', 'gpc']);
  assert.deepEqual(B.rulesetPlan(ids, true, B.defaults(), { ads: true }).enableRulesetIds, ['removeparam', 'gpc'], 'dynamic lists do not disable it');
  var off = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { gpc: false }));
  assert.deepEqual(off.disableRulesetIds, ['gpc']);
  var allOff = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { ads: false, trackers: false, stripTrackingParams: false }));
  assert.deepEqual(allOff.enableRulesetIds, ['gpc'], 'independent of Ads / Trackers');
  assert.deepEqual(B.rulesetPlan(ids, false, B.defaults()).enableRulesetIds, [], 'master switch off');
  assert.deepEqual(B.countMatches([{ rule: { rulesetId: 'gpc', ruleId: 1 } }]), { ads: 0, trackers: 0, cookies: 0, banners: 0 });
});

test('gpc: rules/gpc.json sets Sec-GPC on page loads, above list exceptions and below the allowlist', function () {
  var rules = JSON.parse(readFile('rules/gpc.json'));
  assert.equal(rules.length, 1);
  var r = rules[0];
  assert.deepEqual(r.action, { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] });
  assert.deepEqual(r.condition, { resourceTypes: ['main_frame'] }, 'page loads only: Chrome counts each modifyHeaders match in the badge');
  assert.ok(r.priority > 4, 'a list @@ exception (priority 2) must not drop the header');
  assert.ok(r.priority < B.allowlistRules(true, ['a.com'])[0].priority, 'allowAllRequests of an allowlisted site outranks it (no header there)');
});

test('gpc: contentScriptPlan registers the MAIN-world script in every frame, allowlist excluded', function () {
  var plan = B.contentScriptPlan(true, Object.assign(B.defaults(), { allowlist: ['off.com'] }), []);
  var g = plan.filter(function (s) { return s.id === 'as-gpc'; })[0];
  assert.deepEqual(g, {
    id: 'as-gpc', js: ['src/content/gpc.js'], matches: ['http://*/*', 'https://*/*'], world: 'MAIN', allFrames: true,
    runAt: 'document_start', persistAcrossSessions: true, excludeMatches: ['*://*.off.com/*']
  });
  var none = B.contentScriptPlan(true, Object.assign(B.defaults(), { gpc: false }), []);
  assert.equal(none.filter(function (s) { return s.id === 'as-gpc'; }).length, 0, 'switch off');
  var only = B.contentScriptPlan(true, Object.assign(B.defaults(), { ads: false, hideCookieBanners: false }), []);
  assert.deepEqual(only.map(function (s) { return s.id; }), ['as-gpc'], 'independent of Ads / Cookie banners');
  assert.deepEqual(B.contentScriptPlan(false, B.defaults(), []), [], 'master switch off');
});

test('countMatches: curated rulesets count as ads / trackers', function () {
  var m = function (rulesetId, ruleId) { return { rule: { rulesetId: rulesetId, ruleId: ruleId }, tabId: 1 }; };
  var c = B.countMatches([m('ads_curated', 1), m('ads_curated', 1), m('privacy_curated', 1), m('ads_1', 2)]);
  assert.deepEqual(c, { ads: 3, trackers: 1, cookies: 0, banners: 0 });
});

test('allowlistRules: one allowAllRequests rule above all static priorities', function () {
  assert.deepEqual(B.allowlistRules(true, []), []);
  assert.deepEqual(B.allowlistRules(false, ['a.com']), []);
  var r = B.allowlistRules(true, ['b.com', 'a.com']);
  assert.equal(r.length, 1);
  assert.equal(r[0].action.type, 'allowAllRequests');
  assert.ok(r[0].priority > 4);
  assert.deepEqual(r[0].condition, { requestDomains: ['a.com', 'b.com'], resourceTypes: ['main_frame', 'sub_frame'] });
});

test('countMatches: by ruleset, allow-rule ids and the dynamic allowlist rule ignored', function () {
  var m = function (rulesetId, ruleId) { return { rule: { rulesetId: rulesetId, ruleId: ruleId }, tabId: 1 }; };
  var c = B.countMatches([
    m('ads_1', 3), m('ads_1', 500001), m('client_ads', 500001), m('client_ads', 500002), m('privacy_1', 9), m('trackers', 2),
    m('cookie_strip', 1), m('cookie_strip', 2), m('cookies_1', 4), m('_dynamic', 1), {}, null
  ]);
  assert.deepEqual(c, { ads: 1, trackers: 2, cookies: 2, banners: 1 }, 'client_ads holds allow rules only: never counted');
});

test('rules/client_ads.json: only allow rules for Twitch client-side ad requests, above every list rule', function () {
  var rules = JSON.parse(readFile('rules/client_ads.json'));
  assert.ok(rules.length >= 1);
  rules.forEach(function (r) {
    assert.equal(r.action.type, 'allow', 'no block rule: live ad requests must not fail (Twitch ad-block notice)');
    assert.ok(r.id >= B.ALLOW_ID_BASE, 'allow id range');
    assert.ok(r.priority > 4, 'above every static / dynamic list rule');
    assert.ok(r.priority < B.allowlistRules(true, ['a.com'])[0].priority, 'below the site allowlist');
    assert.deepEqual(r.condition.initiatorDomains, ['twitch.tv']);
  });
  var filters = rules.map(function (r) { return r.condition.urlFilter; });
  assert.ok(filters.indexOf('||edge.ads.twitch.tv^') !== -1, 'edge.ads.twitch.tv let through');
  assert.equal(B.rulesetFeature('client_ads'), null, 'not part of the general Ads switch');
});

test('hostPatterns and contentScriptPlan', function () {
  assert.deepEqual(B.hostPatterns('example.com'), ['*://*.example.com/*']);
  assert.deepEqual(B.hostPatterns('10.0.0.1'), ['*://10.0.0.1/*']);
  assert.deepEqual(B.hostPatterns('bad_host.com'), []);
  assert.deepEqual(B.contentScriptPlan(false, B.defaults(), []), []);
  var plan = B.contentScriptPlan(true, Object.assign(B.defaults(), { allowlist: ['off.com'] }), { main: ['gh.org'], excepted: ['exc.org', 'gh.org'] });
  assert.deepEqual(plan.map(function (s) { return s.id; }),
    ['as-css-ads', 'as-css-ads-top', 'as-css-ads-exc', 'as-css-cookies', 'as-css-cookies-exc', 'as-site', 'as-css-youtube', 'as-gpc'], 'no scriptlet hosts given: no as-scriptlets');
  var byId = {};
  plan.forEach(function (s) { byId[s.id] = s; });
  assert.deepEqual(byId['as-css-ads'].css, ['rules/cosmetic/ads_generic.css']);
  assert.deepEqual(byId['as-css-ads'].excludeMatches, ['*://*.off.com/*', '*://*.gh.org/*']);
  assert.equal(byId['as-css-ads'].allFrames, true, 'generic ad core: every frame');
  assert.deepEqual(byId['as-css-ads-top'].css, ['rules/cosmetic/ads_generic_top.css']);
  assert.equal(byId['as-css-ads-top'].allFrames, false, 'other generic ad selectors: top frame only');
  assert.deepEqual(byId['as-css-ads-top'].excludeMatches, byId['as-css-ads'].excludeMatches);
  assert.deepEqual(byId['as-css-cookies'].css, ['rules/cosmetic/cookies_generic.css']);
  assert.equal(byId['as-css-cookies'].allFrames, false, 'cookie-banner generic CSS: top frame only');
  assert.deepEqual(byId['as-css-cookies'].excludeMatches, byId['as-css-ads'].excludeMatches, 'exception hosts keep the big files');
  assert.deepEqual(byId['as-css-ads-exc'].css, ['rules/cosmetic/ads_excepted.css']);
  assert.equal(byId['as-css-ads-exc'].allFrames, true);
  assert.deepEqual(byId['as-css-ads-exc'].excludeMatches, ['*://*.off.com/*', '*://*.exc.org/*', '*://*.gh.org/*'], 'excepted selectors skip the exception hosts');
  assert.deepEqual(byId['as-css-cookies-exc'].css, ['rules/cosmetic/cookies_excepted.css']);
  assert.equal(byId['as-css-cookies-exc'].allFrames, false);
  assert.deepEqual(byId['as-css-cookies-exc'].excludeMatches, byId['as-css-ads-exc'].excludeMatches);
  assert.deepEqual(byId['as-site'].excludeMatches, ['*://*.off.com/*'], 'page script: allowlist only');
  assert.equal(byId['as-site'].allFrames, false);
  var arr = B.contentScriptPlan(true, B.defaults(), ['exc.org']);
  assert.deepEqual(arr[0].excludeMatches, ['*://*.exc.org/*'], 'a plain array excludes from every file');
  assert.deepEqual(arr[2].excludeMatches, ['*://*.exc.org/*']);
  plan.forEach(function (s) { assert.equal(s.id.indexOf(B.SCRIPT_PREFIX), 0); assert.equal(s.runAt, 'document_start'); });
  var ac = B.contentScriptPlan(true, Object.assign(B.defaults(), { ads: false, hideCookieBanners: false, autoRejectCookies: true, gpc: false }), []);
  assert.deepEqual(ac.map(function (s) { return s.id; }), ['as-autoconsent']);
  assert.equal(ac[0].matchOriginAsFallback, true);
  assert.equal(ac[0].excludeMatches, undefined);
});

test('contentScriptPlan: YouTube CSS and the MAIN-world scriptlets only on their hosts, allowlist excluded, follow Ads + Page scripts', function () {
  var hosts = B.scriptletHosts(JSON.parse(readFile('rules/scriptlets.json')));
  assert.deepEqual(hosts, ['m.youtube.com', 'youtube-nocookie.com', 'youtube.com', 'youtubekids.com'], 'm.youtube.com (rule youtube-mobile) is also inside youtube.com');
  var plan = B.contentScriptPlan(true, Object.assign(B.defaults(), { allowlist: ['off.com'] }), ['exc.org'], hosts);
  assert.deepEqual(plan.map(function (s) { return s.id; }), ['as-css-ads', 'as-css-ads-top', 'as-css-ads-exc', 'as-css-cookies', 'as-css-cookies-exc', 'as-site', 'as-css-youtube', 'as-scriptlets', 'as-gpc']);
  var css = plan[6], sl = plan[7];
  assert.deepEqual(css.css, ['rules/cosmetic/youtube.css']);
  assert.deepEqual(css.matches, ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtubekids.com/*']);
  assert.deepEqual(css.excludeMatches, ['*://*.off.com/*'], 'YouTube CSS: allowlist only');
  assert.deepEqual(sl.js, ['build/scriptlets-main.js']);
  assert.equal(sl.world, 'MAIN');
  assert.equal(sl.runAt, 'document_start');
  assert.equal(sl.allFrames, true);
  assert.equal(sl.matchOriginAsFallback, undefined, 'no about:blank fallback: sandboxed blank frames logged script errors');
  assert.equal(sl.persistAcrossSessions, true);
  assert.deepEqual(sl.matches, ['*://*.m.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtube.com/*', '*://*.youtubekids.com/*']);
  assert.deepEqual(sl.excludeMatches, ['*://*.off.com/*']);
  var noAllow = B.contentScriptPlan(true, Object.assign(B.defaults(), { gpc: false }), [], hosts);
  assert.equal(noAllow[noAllow.length - 1].id, 'as-scriptlets');
  assert.equal(noAllow[noAllow.length - 1].excludeMatches, undefined);
  var ids = function (p) { return p.map(function (s) { return s.id; }); };
  assert.equal(ids(B.contentScriptPlan(true, Object.assign(B.defaults(), { scriptlets: false }), [], hosts)).indexOf('as-scriptlets'), -1, 'page scripts off');
  var noAds = ids(B.contentScriptPlan(true, Object.assign(B.defaults(), { ads: false }), [], hosts));
  assert.equal(noAds.indexOf('as-scriptlets'), -1, 'Ads off: no scriptlets');
  assert.equal(noAds.indexOf('as-css-youtube'), -1, 'Ads off: no YouTube CSS');
  assert.deepEqual(B.contentScriptPlan(false, B.defaults(), [], hosts), [], 'master switch off');
  assert.equal(ids(B.contentScriptPlan(true, B.defaults(), [], [])).indexOf('as-scriptlets'), -1, 'no hosts (rules not loaded): nothing registered');
  assert.deepEqual(B.scriptletHosts({ rules: [{ hosts: ['A.com', 'b.com', 'b.com', 'bad host', 5] }, null, { hosts: 'x' }] }), ['b.com']);
  assert.deepEqual(B.scriptletHosts(null), []);
});

var SITE = {
  v: 1,
  ads: { 'example.com': ['.side-ad', '.shared'], 'sub.example.com': ['.deep-ad'] },
  cookies: { 'example.com': ['#consent'] },
  exceptions: { 'sub.example.com': ['.shared', '.generic-ad'] },
  genericExceptionHosts: ['sub.example.com'],
  generichide: ['nogeneric.net'],
  elemhide: ['nothing.org']
};
var GENERIC = { ads: ['.generic-ad', '.g2'], cookies: ['.cookie-bar'] };

test('cssForHost: site rules for host and parents, exceptions, categories', function () {
  var r = B.cssForHost('www.example.com', SITE, null, { ads: true, cookies: true });
  assert.equal(r.css, '.side-ad{display:none!important}\n.shared{display:none!important}\n#consent{display:none!important}');
  assert.deepEqual(r.cookieSelectors, ['#consent']);
  var onlyCookies = B.cssForHost('example.com', SITE, null, { ads: false, cookies: true });
  assert.equal(onlyCookies.css, '#consent{display:none!important}');
  assert.equal(B.cssForHost('nothing.org', SITE, GENERIC, { ads: true, cookies: true }).css, '');
  assert.equal(B.cssForHost('unknown.net', SITE, null, { ads: true, cookies: true }).css, '');
});

test('cssForHost: exception hosts get the generic selectors minus their exceptions', function () {
  assert.ok(B.needsGeneric('a.sub.example.com', SITE));
  assert.notOk(B.needsGeneric('example.com', SITE));
  assert.notOk(B.needsGeneric('nogeneric.net', SITE));
  var r = B.cssForHost('sub.example.com', SITE, GENERIC, { ads: true, cookies: true });
  var sels = r.css.split('\n').map(function (l) { return l.replace('{display:none!important}', ''); });
  assert.deepEqual(sels, ['.deep-ad', '.side-ad', '#consent', '.g2', '.cookie-bar']);
  assert.deepEqual(B.cosmeticExcludeHosts(SITE), { main: ['nogeneric.net', 'nothing.org'], excepted: ['nogeneric.net', 'nothing.org', 'sub.example.com'] });
  assert.equal(B.genericSource('a.sub.example.com', SITE), 'excepted');
  assert.equal(B.genericSource('example.com', SITE), null);
});

test('genericSource: genericFullHosts get the whole generic list; generichide / elemhide nothing', function () {
  var site = Object.assign({}, SITE, { genericFullHosts: ['sub.example.com', 'nogeneric.net'] });
  assert.equal(B.genericSource('www.sub.example.com', site), 'full');
  assert.equal(B.genericSource('nogeneric.net', site), null, 'generichide wins');
  assert.equal(B.genericSource('nothing.org', site), null);
  assert.equal(B.genericSource('x.com', null), null);
  assert.deepEqual(B.cosmeticExcludeHosts(site).main, ['nogeneric.net', 'nothing.org', 'sub.example.com']);
  assert.deepEqual(B.cosmeticExcludeHosts(null), { main: [], excepted: [] });
});

test('site shards: every parent of a page host that can hold rules is in the page host\'s shard', function () {
  assert.equal(B.siteShardKey('a.b.example.com'), 'example.com');
  assert.equal(B.siteShardKey('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(B.siteShardKey('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(B.siteShardKey('example.com'), 'example.com');
  assert.equal(B.siteShard('WWW.Example.com'), B.siteShard('example.com'));
  assert.equal(B.siteShard('news.bbc.co.uk'), B.siteShard('bbc.co.uk'));
  assert.equal(B.siteShard('not a host'), -1);
  assert.equal(B.siteShardName(10), '0a');
  assert.equal(B.siteShardName(127), '7f');
  var split = B.splitSite(SITE);
  assert.equal(split.shards.length, B.SITE_SHARDS);
  assert.deepEqual(split.index, { v: 2, n: B.SITE_SHARDS, genericExceptionHosts: ['sub.example.com'], generichide: ['nogeneric.net'], elemhide: ['nothing.org'], genericFullHosts: [] });
  ['www.example.com', 'a.sub.example.com', 'nothing.org', 'nogeneric.net', 'unknown.net'].forEach(function (h) {
    var shard = split.shards[B.siteShard(h)];
    [[null, { ads: true, cookies: true }], [GENERIC, { ads: true, cookies: false }]].forEach(function (a) {
      assert.deepEqual(B.cssForHost(h, shard, a[0], a[1]), B.cssForHost(h, SITE, a[0], a[1]), h);
    });
    assert.equal(B.genericSource(h, shard), B.genericSource(h, SITE), h);
  });
  var g = B.splitSite({ ads: { 'gov.uk': ['.gov'], uk: ['.tld'], 'x.gov.uk': ['.x'] } });
  g.shards.forEach(function (sh) { assert.deepEqual(sh.ads['gov.uk'], ['.gov'], 'public-suffix-like hosts are in every shard'); assert.deepEqual(sh.ads.uk, ['.tld']); });
  assert.deepEqual(B.cssForHost('www.x.gov.uk', g.shards[B.siteShard('www.x.gov.uk')], null, { ads: true }).selectors, 3);
});

test('site shards: the JavaScript split equals the packaged rules/cosmetic/site/ files (tools/cosmetic.py)', function () {
  var index = JSON.parse(readFile('rules/cosmetic/site/index.json'));
  assert.equal(index.n, B.SITE_SHARDS);
  var shards = [], merged = { v: 1, ads: {}, cookies: {}, exceptions: {} };
  for (var i = 0; i < index.n; i++) shards.push(JSON.parse(readFile('rules/cosmetic/site/' + B.siteShardName(i) + '.json')));
  shards.forEach(function (sh) { ['ads', 'cookies', 'exceptions'].forEach(function (k) { Object.assign(merged[k], sh[k]); }); });
  ['ads', 'cookies', 'exceptions'].forEach(function (k) {
    var m = merged[k], sorted = {};
    Object.keys(m).sort().forEach(function (h) { sorted[h] = m[h]; });
    merged[k] = sorted;
  });
  ['genericExceptionHosts', 'generichide', 'elemhide', 'genericFullHosts'].forEach(function (k) { merged[k] = index[k]; });
  var split = B.splitSite(merged);
  assert.deepEqual(split.index, index);
  for (i = 0; i < index.n; i++) assert.deepEqual(split.shards[i], shards[i], 'shard ' + B.siteShardName(i));
  assert.ok(Object.keys(merged.ads).length > 5000, 'real data');
});

test('popupSite', function () {
  var s = B.popupSite({ url: 'https://www.news.org/a', enabled: true, allowlist: [] });
  assert.equal(s.web, true);
  assert.equal(s.hostname, 'www.news.org');
  assert.equal(s.host, 'news.org');
  assert.equal(s.on, true);
  assert.equal(B.popupSite({ url: 'https://www.news.org/a', enabled: true, allowlist: ['news.org'] }).on, false);
  assert.equal(B.popupSite({ url: 'chrome://extensions' }).web, false);
  assert.includes(B.popupSite({ url: 'https://a.com/', enabled: false }).detail, 'switched off');
});

test('rulesetPlan: updated (dynamic) categories disable only their list rulesets', function () {
  var ids = ['client_ads', 'trackers', 'ads_1', 'ads_2', 'ads_curated', 'privacy_1', 'privacy_curated', 'cookies_1', 'cookie_strip'];
  var p = B.rulesetPlan(ids, true, B.defaults(), { ads: true, hideCookieBanners: true });
  assert.deepEqual(p.enableRulesetIds, ['ads_curated', 'privacy_1', 'privacy_curated', 'cookie_strip']);
  assert.deepEqual(p.disableRulesetIds, ['ads_1', 'ads_2', 'cookies_1']);
  var all = B.rulesetPlan(ids, true, B.defaults(), { ads: true, trackers: true, hideCookieBanners: true });
  assert.deepEqual(all.enableRulesetIds, ['ads_curated', 'privacy_curated', 'cookie_strip']);
  var none = B.rulesetPlan(ids, true, B.defaults(), {});
  assert.deepEqual(none, B.rulesetPlan(ids, true, B.defaults()), 'no dynamic = old behaviour');
  var off = B.rulesetPlan(ids, false, B.defaults(), { ads: true });
  assert.deepEqual(off.enableRulesetIds, []);
  var adsOff = B.rulesetPlan(ids, true, Object.assign(B.defaults(), { ads: false }), {});
  assert.deepEqual(adsOff.disableRulesetIds, ['ads_1', 'ads_2', 'ads_curated']);
  assert.ok(B.isListRuleset('cookies_3'));
  assert.notOk(B.isListRuleset('ads_curated'));
  assert.notOk(B.isListRuleset('cookie_strip'));
});

test('dynamic id ranges: base + static id; allowlist rule 1 belongs to no category', function () {
  assert.equal(B.dynamicFeature(1), null);
  assert.equal(B.dynamicFeature(1000000), null);
  assert.equal(B.dynamicFeature(1000001), 'ads');
  assert.equal(B.dynamicFeature(1500001), 'ads');
  assert.equal(B.dynamicFeature(2000005), 'trackers');
  assert.equal(B.dynamicFeature(3999999), 'hideCookieBanners');
  assert.equal(B.dynamicFeature(4000001), null);
  assert.deepEqual(B.dynamicCounts([1, 1000001, 1500001, 3000002]), { ads: 2, trackers: 0, hideCookieBanners: 1 });
});

test('countMatches: _dynamic matches counted by id range, allow ranges and the allowlist ignored', function () {
  var d = function (ruleId) { return { rule: { rulesetId: '_dynamic', ruleId: ruleId }, tabId: 1 }; };
  var c = B.countMatches([d(1), d(1000001), d(1000002), d(1500001), d(2000010), d(2500010), d(3000003), d(3500003), d(9000000)]);
  assert.deepEqual(c, { ads: 2, trackers: 1, cookies: 0, banners: 1 });
  var s = B.countMatches([{ rule: { rulesetId: 'ads_1', ruleId: 500001 } }, { rule: { rulesetId: 'ads_1', ruleId: 3 } }]);
  assert.equal(s.ads, 1, 'static allow rules still ignored');
});
