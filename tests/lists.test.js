/* Pure decisions of the weekly list update (src/shared/lists.js). */
loadSrc('src/shared/lists.js');
var L = __TAS__.lists;

var INFO = {
  lists: { easylist: { version: '202611100000' }, easyprivacy: { version: '202611100010' }, 'easylist-cookie': { version: '2026-11-10 08:30 UTC' } },
  rulesets: { ads_1: { rules: 3000 }, ads_2: { rules: 781 }, ads_curated: { rules: 1 }, privacy_1: { rules: 9239 }, cookies_1: { rules: 1794 }, cookie_strip: { rules: 4 } }
};
var PKG = L.packagedLists(INFO);
var DAY = 24 * 3600 * 1000;

test('packagedLists: versions and rule counts of the numbered rulesets only', function () {
  assert.deepEqual(PKG, {
    easylist: { version: '202611100000', rules: 3781 },
    easyprivacy: { version: '202611100010', rules: 9239 },
    'easylist-cookie': { version: '2026-11-10 08:30 UTC', rules: 1794 }
  });
});

test('versions: EasyList digits, cookie-list dates and "Last modified" dates compare', function () {
  assert.equal(L.parseVersion('202611140001'), Date.UTC(2026, 10, 14, 0, 1));
  assert.equal(L.parseVersion('2026-11-12 20:50 UTC'), Date.UTC(2026, 10, 12, 20, 50));
  assert.equal(L.parseVersion('14 Nov 2026 00:01 UTC'), Date.UTC(2026, 10, 14, 0, 1));
  assert.equal(L.parseVersion('banana'), null);
  assert.equal(L.parseVersion(null), null);
  assert.equal(L.compareVersions('202611140001', '202611100000'), 1);
  assert.equal(L.compareVersions('2026-11-10 08:30 UTC', '2026-11-10 08:30 UTC'), 0);
  assert.equal(L.compareVersions('202611090000', '2026-11-10 08:30 UTC'), -1);
  assert.equal(L.compareVersions('x', '202611090000'), null);
});

test('checkList: header, 60 % of the packaged rules, not older than the version in use', function () {
  var rules = function (n) { var a = []; for (var i = 0; i < n; i++) a.push({ id: i + 1 }); return a; };
  var p = { version: '202611100000', rules: 100 };
  assert.includes(L.checkList({ version: null, rules: rules(100) }, p, p.version).error, 'header');
  assert.includes(L.checkList({ version: 'soon', rules: rules(100) }, p, p.version).error, 'version format');
  assert.includes(L.checkList({ version: '202611120000', rules: rules(59) }, p, p.version).error, 'only 59 rules');
  assert.deepEqual(L.checkList({ version: '202611120000', rules: rules(60) }, p, p.version), { newer: true });
  assert.deepEqual(L.checkList({ version: '202611100000', rules: rules(60) }, p, p.version), { newer: false });
  assert.includes(L.checkList({ version: '202611010000', rules: rules(90) }, p, p.version).error, 'older');
});

test('decide: all or nothing; nothing newer = up to date', function () {
  assert.deepEqual(L.decide({ easylist: { newer: true }, easyprivacy: { newer: false }, 'easylist-cookie': { newer: false } }),
    { apply: true, upToDate: false, errors: {} });
  assert.deepEqual(L.decide({ easylist: { newer: false }, easyprivacy: { newer: false }, 'easylist-cookie': { newer: false } }),
    { apply: false, upToDate: true, errors: {} });
  var d = L.decide({ easylist: { newer: true }, easyprivacy: { error: 'HTTP 500' }, 'easylist-cookie': { newer: true } });
  assert.deepEqual(d, { apply: false, upToDate: false, errors: { easyprivacy: 'HTTP 500' } });
});

test('toDynamic: id = base + static id; out-of-range ids refused', function () {
  var r = L.toDynamic([{ id: 1, priority: 1, action: { type: 'block' }, condition: {} }, { id: 500001, priority: 2, action: { type: 'allow' }, condition: {} }], 2000000);
  assert.deepEqual(r.map(function (x) { return x.id; }), [2000001, 2500001]);
  assert.throws(function () { L.toDynamic([{ id: 1000000 }], 1000000); });
  assert.throws(function () { L.toDynamic([{ id: 0 }], 1000000); });
});

test('limits: Chrome 121+ constants, Chrome 120 fallback; fitCheck counts all categories + reserved', function () {
  assert.deepEqual(L.limitsFrom({ MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, MAX_NUMBER_OF_REGEX_RULES: 1000 }),
    { dynamic: 30000, unsafe: 5000, regex: 1000 });
  assert.deepEqual(L.limitsFrom({ MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000 }), { dynamic: 5000, unsafe: 5000, regex: 1000 });
  var mk = function (n, type, rx) { var a = []; for (var i = 0; i < n; i++) a.push({ action: { type: type || 'block' }, condition: rx ? { regexFilter: 'a' } : {} }); return a; };
  var lim = { dynamic: 10, unsafe: 2, regex: 3 };
  assert.equal(L.fitCheck({ ads: mk(5), trackers: mk(4) }, lim, 1), null);
  assert.includes(L.fitCheck({ ads: mk(5), trackers: mk(5) }, lim, 1), '11 rules do not fit');
  assert.includes(L.fitCheck({ ads: mk(3, 'modifyHeaders') }, lim, 0), 'unsafe');
  assert.includes(L.fitCheck({ ads: mk(4, 'block', true) }, lim, 0), 'regex');
  assert.equal(L.fitCheck({ ads: mk(2, 'allowAllRequests') }, lim, 0), null);
});

test('isDue: weekly after the last check; first check once the lists in use are a week old', function () {
  var t0 = Date.UTC(2026, 10, 10, 8, 30);
  assert.equal(L.isDue(null, PKG, t0 + 6 * DAY), false);
  assert.equal(L.isDue(null, PKG, t0 + 7 * DAY + 1), true);
  assert.equal(L.isDue({ lastCheck: t0 }, PKG, t0 + 6 * DAY), false);
  assert.equal(L.isDue({ lastCheck: t0 }, PKG, t0 + 7 * DAY - 60000), true, 'alarm a minute early still counts');
  var upd = { source: 'updated', lists: { easylist: { version: '202611200000' }, easyprivacy: { version: '202611200000' }, 'easylist-cookie': { version: '2026-11-20 00:00 UTC' } } };
  assert.equal(L.isDue(upd, PKG, Date.UTC(2026, 10, 25)), false, 'versions in use are the updated ones');
});

test('shouldRevert: only updated lists, only when a packaged one is newer', function () {
  var upd = function (v) { return { source: 'updated', lists: { easylist: { version: v }, easyprivacy: { version: '202611200000' }, 'easylist-cookie': { version: '2026-11-20 00:00 UTC' } } }; };
  assert.equal(L.shouldRevert(null, PKG), false);
  assert.equal(L.shouldRevert({ source: 'packaged', lists: {} }, PKG), false);
  assert.equal(L.shouldRevert(upd('202611200000'), PKG), false);
  assert.equal(L.shouldRevert(upd('202611010000'), PKG), true);
});

test('addPackagedGenericExceptions keeps hosts that except packaged generic selectors', function () {
  var site = { v: 1, exceptions: { 'a.com': ['.x'], 'b.com': ['.old-generic'], 'c.com': ['.site-only'] }, genericExceptionHosts: ['a.com'] };
  var out = L.addPackagedGenericExceptions(site, { ads: ['.old-generic'], cookies: [] });
  assert.deepEqual(out.genericExceptionHosts, ['a.com', 'b.com']);
  assert.deepEqual(site.genericExceptionHosts, ['a.com'], 'input not modified');
  assert.deepEqual(L.addPackagedGenericExceptions(site, null).genericExceptionHosts, ['a.com']);
});

test('addPackagedGenericExceptions: genericFullHosts are the hosts excepting a selector outside the excepted files', function () {
  var site = { v: 1, exceptions: { 'a.com': ['.x'], 'b.com': ['.old-generic'], 'c.com': ['.site-only'], 'd.com': ['.big'] }, genericExceptionHosts: ['a.com'] };
  var gen = { ads: ['.old-generic', '.big'], cookies: [] };
  var out = L.addPackagedGenericExceptions(site, gen, { ads: ['.old-generic'], cookies: [] });
  assert.deepEqual(out.genericExceptionHosts, ['a.com', 'b.com', 'd.com']);
  assert.deepEqual(out.genericFullHosts, ['d.com'], '.big sits in a big generic file');
  assert.deepEqual(L.addPackagedGenericExceptions(site, gen, null).genericFullHosts, ['b.com', 'd.com'], 'excepted files unknown: whole list for all');
  assert.equal(site.genericFullHosts, undefined, 'input not modified');
});

test('legacySite: whole site data stored by an older version sends its exception hosts to the whole generic list', function () {
  var old = { v: 1, ads: {}, genericExceptionHosts: ['a.com'] };
  assert.deepEqual(L.legacySite(old).genericFullHosts, ['a.com']);
  assert.equal(old.genericFullHosts, undefined);
  assert.deepEqual(L.legacySite({ v: 1, genericExceptionHosts: ['a.com'], genericFullHosts: [] }).genericFullHosts, []);
  assert.equal(L.siteShardStorageKey('0a'), 'listSite/0a');
  assert.equal(L.SITE_INDEX_KEY, 'listSite/index');
});

test('metadata helpers and status rows', function () {
  var conv = { lists: { easylist: { version: 'v1' }, easyprivacy: { version: 'v2' }, 'easylist-cookie': { version: 'v3' } } };
  var m = L.successMeta(conv, { ads: 10, trackers: 20, hideCookieBanners: 30 }, 1000);
  assert.equal(m.source, 'updated');
  assert.deepEqual(m.lists.easyprivacy, { version: 'v2', fetchedAt: 1000, rules: 20, ok: true, error: null });
  var rows = L.statusRows(m, PKG);
  assert.equal(rows[0].status, 'updated');
  assert.equal(rows[2].rules, 30);
  var failed = L.checkedMeta(m, 2000, false, 'nope', { easylist: 'HTTP 404' });
  assert.equal(failed.source, 'updated');
  assert.equal(failed.lists.easylist.version, 'v1', 'version in use kept');
  assert.equal(failed.lastCheck, 2000);
  assert.equal(L.statusRows(failed, PKG)[0].status, 'last check failed: HTTP 404');
  var pk = L.statusRows(L.packagedMeta(failed, 3000, 'reset'), PKG);
  assert.deepEqual([pk[0].version, pk[0].rules, pk[0].status, pk[0].updatedAt], ['202611100000', 3781, 'built in', null]);
  assert.equal(L.statusRows(null, PKG)[1].status, 'built in');
});
