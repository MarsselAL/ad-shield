/* Element picker helpers (src/shared/selector.js) and "My filters" (src/shared/userfilters.js). */
loadSrc('src/config.js', 'src/shared/blocking.js', 'src/shared/userfilters.js', 'src/shared/selector.js');
var B = __TAS__.blocking;
var U = __TAS__.userFilters;
var Sel = __TAS__.selector;

test('looksRandom: generated ids and classes are rejected, readable ones kept', function () {
  ['post-12345', 'ad_93821', 'css-1q2w3e', 'jsx-2412', 'sc-bdVaJa', 'kOaVfE', 'bdVaJa', 'Button_root__a1B2c',
    'a1b2c3', 'item-3fa9e0', 'xY7kQ', 'aB3dE', 'x'.repeat(41), ''].forEach(function (t) {
    assert.ok(Sel.looksRandom(t), t);
  });
  ['ad-banner', 'sidebar', 'top-ad', 'ad-300x250', 'card__title', 'mp4Player', 'navBar', 'myNavBar', 'header-main',
    'h264video', 'col-md-4', 'isOpen', 'AdSlot'].forEach(function (t) {
    assert.notOk(Sel.looksRandom(t), t);
  });
});

test('stableId / stableClasses skip random names and names that need escaping', function () {
  assert.equal(Sel.stableId('main-ad'), 'main-ad');
  assert.equal(Sel.stableId('ad-98231'), null);
  assert.equal(Sel.stableId('1abc'), null, 'starts with a digit: would need escaping');
  assert.equal(Sel.stableId('a:b'), null);
  assert.equal(Sel.stableId(5), null);
  assert.deepEqual(Sel.stableClasses(['ad', 'css-1q2w3e', 'w-[300px]', 'ad', 'banner', 'md:flex']), ['ad', 'banner']);
});

test('step builds id, tag.class and nth-of-type steps', function () {
  assert.equal(Sel.step({ tag: 'DIV', id: 'top', useId: true }), '#top');
  assert.equal(Sel.step({ tag: 'DIV', id: 'x-99999', useId: true, classes: ['ad'], useClasses: 1 }), 'div.ad');
  assert.equal(Sel.step({ tag: 'SECTION', classes: ['a', 'css-1q2w3e', 'b', 'c'], useClasses: 2 }), 'section.a.b');
  assert.equal(Sel.step({ tag: 'LI', index: 3, sameTag: 5, nth: true }), 'li:nth-of-type(3)');
  assert.equal(Sel.step({ tag: 'LI', index: 1, sameTag: 1, nth: true }), 'li', 'only child of its type: no nth');
});

test('selectorError: accepts normal selectors, rejects anything that escapes the CSS rule', function () {
  ['#ad', '.a.b > div:nth-of-type(2)', 'div[style="width:300px;height:250px"]', 'a[href*="{x}"]',
    'div:has(> .sponsored)', 'span.a, span.b', '#\\31 23'].forEach(function (s) {
    assert.equal(U.selectorError(s), null, s);
  });
  [['', 'empty'], ['div{color:red}', '{'], ['div;x', ';'], ['a /* c */', 'comments'], ['@import x', 'at-rules'],
    ['> div', 'combinator'], ['div,', 'combinator'], ['div[x', 'unbalanced'], ['div:not(.a', 'unbalanced'],
    ['div[x="y]', 'unclosed'], ['div\nbody', 'control'], ['a\\', 'backslash'], ['div)', 'unbalanced'],
    ['x'.repeat(501), 'longer']].forEach(function (c) {
    var e = U.selectorError(c[0]);
    assert.ok(e, 'rejects ' + c[0].slice(0, 30));
    assert.includes(e, c[1]);
  });
  assert.equal(U.selectorError(null), 'not text');
});

test('normalize: drops bad hosts / selectors / duplicates, keeps order, never throws', function () {
  assert.deepEqual(U.normalize(null), {});
  assert.deepEqual(U.normalize([1]), {});
  assert.deepEqual(U.normalize('x'), {});
  var n = U.normalize({ 'example.com': ['.a', '.a', ' .b ', 'x{y}', 5], 'Bad Host': ['.c'], 'WWW.X.ORG': ['.d'], 'y.net': 'nope', 'z.io': [] });
  assert.deepEqual(n, { 'example.com': ['.a', '.b'] }, 'keys must already be normalised hosts');
});

test('normalize caps: per host and in total', function () {
  var many = [];
  for (var i = 0; i < U.MAX_PER_HOST + 20; i++) many.push('.a' + i);
  assert.equal(U.normalize({ 'a.com': many })['a.com'].length, U.MAX_PER_HOST);
  var big = {};
  for (var h = 0; h < 30; h++) big['h' + h + '.com'] = many.slice(0, U.MAX_PER_HOST);
  var n = U.normalize(big), tot = 0;
  Object.keys(n).forEach(function (k) { tot += n[k].length; });
  assert.equal(tot, U.MAX_TOTAL);
});

test('add: the picker path (host normalised, duplicates, caps, bad selectors)', function () {
  var r = U.add({}, 'News.Example.com', '#ad');
  assert.ok(r.ok && r.added);
  assert.deepEqual(r.value, { 'news.example.com': ['#ad'] });
  var again = U.add(r.value, 'news.example.com', '#ad');
  assert.ok(again.ok);
  assert.equal(again.added, false);
  assert.notOk(U.add({}, 'not a host', '#x').ok);
  var bad = U.add({}, 'a.com', 'div{}');
  assert.notOk(bad.ok);
  assert.includes(bad.error, 'Selector');
  var full = [];
  for (var i = 0; i < U.MAX_PER_HOST; i++) full.push('.x' + i);
  var capped = U.add({ 'a.com': full }, 'a.com', '.new');
  assert.notOk(capped.ok);
  assert.includes(capped.error, String(U.MAX_PER_HOST));
  var big = {};
  for (var h = 0; h < U.MAX_TOTAL / U.MAX_PER_HOST; h++) big['h' + h + '.com'] = full.slice();
  assert.notOk(U.add(big, 'other.com', '.y').ok, 'total cap');
});

test('parseText / toText: round trip, comments, several hosts, per-line errors', function () {
  var v = U.parseText('! my list\n\nexample.com##.ad-box\nwww.News.org##div[id="top"] > span\na.com, b.com##.x\nexample.com##.ad-box\n');
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(v.value, { 'a.com': ['.x'], 'b.com': ['.x'], 'example.com': ['.ad-box'], 'www.news.org': ['div[id="top"] > span'] });
  var text = U.toText(v.value);
  assert.equal(text, 'a.com##.x\nb.com##.x\nexample.com##.ad-box\nwww.news.org##div[id="top"] > span');
  assert.deepEqual(U.parseText(text).value, v.value, 'round trip');
  assert.equal(U.toText({}), '');

  var bad = U.parseText('##.global\nexample.com#@#.ad\nfoo\nbad host##.x\n~a.com##.y\nok.com##div{}\nok.com##.fine\n*.x.com##.z');
  assert.notOk(bad.ok);
  assert.equal(bad.value, null);
  assert.equal(bad.errors.length, 7, bad.errors.join(' | '));
  assert.includes(bad.errors[0], 'Line 1: add the site');
  assert.includes(bad.errors[1], 'Line 2: only "site##selector"');
  assert.includes(bad.errors[2], 'Line 3: expected');
  assert.includes(bad.errors[3], 'Line 4: not a valid site');
  assert.includes(bad.errors[4], 'Line 5: not a valid site');
  assert.includes(bad.errors[5], 'Line 6: selector');
  assert.includes(bad.errors[6], 'Line 8: not a valid site');
});

test('parseText: optional DOM check and caps', function () {
  var v = U.parseText('a.com##.ok\na.com##:bogus(', function (s) { return s.indexOf('bogus') !== -1 ? 'is not valid CSS' : null; });
  assert.notOk(v.ok);
  assert.includes(v.errors.join(' '), 'Line 2: selector');
  var lines = [];
  for (var i = 0; i <= U.MAX_PER_HOST; i++) lines.push('a.com##.s' + i);
  var c = U.parseText(lines.join('\n'));
  assert.notOk(c.ok);
  assert.includes(c.errors.join(' '), 'more than ' + U.MAX_PER_HOST);
});

test('selectorsFor / cssFor: host and parent domains, one rule per selector', function () {
  var f = { 'example.com': ['.a', '.b'], 'news.example.com': ['.c', '.a'], 'other.com': ['.z'] };
  assert.deepEqual(U.selectorsFor('news.example.com', f), ['.c', '.a', '.b']);
  assert.deepEqual(U.selectorsFor('www.example.com', f), ['.a', '.b']);
  assert.deepEqual(U.selectorsFor('notexample.com', f), []);
  assert.deepEqual(U.selectorsFor('example.com', null), []);
  assert.deepEqual(U.selectorsFor('x.com', { 'x.com': ['div{}', '.ok'] }), ['.ok'], 'stored junk is skipped');
  assert.equal(U.cssFor('example.com', f), '.a{display:none!important}\n.b{display:none!important}');
  assert.equal(U.cssFor('constructor', f), '');
  assert.deepEqual(U.hosts(f), ['example.com', 'news.example.com', 'other.com']);
});

test('contentScriptPlan: page script runs on user-filter hosts even with Ads and Cookie banners off', function () {
  var off = Object.assign(B.defaults(), { ads: false, hideCookieBanners: false, gpc: false, allowlist: ['skip.com'] });
  assert.deepEqual(B.contentScriptPlan(true, off, [], [], []), []);
  var plan = B.contentScriptPlan(true, off, [], [], ['example.com', 'news.org']);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'as-site');
  assert.deepEqual(plan[0].matches, ['*://*.example.com/*', '*://*.news.org/*']);
  assert.deepEqual(plan[0].excludeMatches, ['*://*.skip.com/*']);
  var on = B.contentScriptPlan(true, B.defaults(), [], [], ['example.com']);
  var site = on.filter(function (s) { return s.id === 'as-site'; })[0];
  assert.deepEqual(site.matches, ['http://*/*', 'https://*/*'], 'already everywhere with Ads on');
  assert.deepEqual(B.contentScriptPlan(false, off, [], [], ['example.com']), []);
});
