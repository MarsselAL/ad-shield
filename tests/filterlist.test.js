/*
 * The JavaScript filter-list converter (src/shared/filterlist.js) against the Python one:
 * tests/fixtures/lists/golden.json is the Python output for the fixture lists (tools/make_golden.py,
 * checked by tests/test_rules.py), so equal output here means the two converters agree.
 */
loadSrc('src/shared/filterlist.js');
var F = __TAS__.filterlist;

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    var o = {};
    Object.keys(v).sort().forEach(function (k) { o[k] = canon(v[k]); });
    return o;
  }
  return v;
}
function same(a, b, msg) { assert.equal(JSON.stringify(canon(a)), JSON.stringify(canon(b)), msg); }

var GOLDEN = JSON.parse(fixture('lists/golden.json'));
var TEXTS = { easylist: fixture('lists/easylist.txt'), easyprivacy: fixture('lists/easyprivacy.txt'), 'easylist-cookie': fixture('lists/easylist-cookie.txt') };
var OUT = F.convertLists(TEXTS);

['easylist', 'easyprivacy', 'easylist-cookie'].forEach(function (key) {
  test('parity: ' + key + ' counts and skip reasons equal the Python converter', function () {
    var a = Object.assign({}, OUT.lists[key]), b = Object.assign({}, GOLDEN.lists[key]);
    delete a.rules; delete b.rules;
    same(a, b);
  });
  test('parity: ' + key + ' DNR rules equal the Python converter (same ids, same order)', function () {
    var a = OUT.lists[key].rules, b = GOLDEN.lists[key].rules;
    assert.equal(a.length, b.length, 'rule count');
    for (var i = 0; i < a.length; i++) same(a[i], b[i], key + ' rule #' + i);
  });
});

test('parity: site-specific cosmetic data equals the Python site.json', function () {
  ['ads', 'cookies', 'exceptions', 'genericExceptionHosts', 'generichide', 'elemhide', 'v'].forEach(function (k) {
    same(OUT.site[k], GOLDEN.site[k], 'site.' + k);
  });
  same(OUT.site, GOLDEN.site);
});

test('parity: generic selectors (used for genericExceptionHosts) equal the Python output', function () {
  same(OUT.generic, GOLDEN.generic);
});

test('IDN hosts: punycode like Python\'s idna codec', function () {
  assert.equal(F.punycode('b\u00fccher'), 'bcher-kva');
  assert.equal(F.toAsciiHost('B\u00fccher.de'), 'xn--bcher-kva.de');
  assert.equal(F.toAsciiHost('stra\u00dfe.example'), 'strasse.example');
  assert.equal(F.toAsciiHost('\u4f8b\u3048.\u30c6\u30b9\u30c8'), 'xn--r8jz45g.xn--zckzah');
  assert.throws(function () { F.toAsciiHost('bad host'); });
});

test('regex safety mirrors Python: lookarounds, backrefs, big repeats, .* + group rejected', function () {
  assert.ok(F.isRe2Safe('^https?:\\/\\/[a-z]{8}\\.com\\/ad\\/'));
  ['(?!x)a', 'a\\1', 'a{21}', '.*(a|b)', 'a\\eb', '(unclosed', '\u00e9'].forEach(function (rx) {
    assert.notOk(F.isRe2Safe(rx), rx);
  });
});

test('requestDomains are split every 1,000 hosts; regex rules capped per list', function () {
  var parsed = [];
  for (var i = 0; i < F.DOMAINS_PER_RULE + 5; i++) parsed.push(F.parseNetwork('||d' + i + '.com^'));
  var r = F.buildNetworkRules(parsed).rules;
  assert.deepEqual(r.map(function (x) { return x.condition.requestDomains.length; }), [F.DOMAINS_PER_RULE, 5]);
  var rx = [F.parseNetwork('/a1b/'), F.parseNetwork('/a2b/'), F.parseNetwork('/a3b/')];
  var b = F.buildNetworkRules(rx, 2);
  assert.equal(b.rules.length, 2);
  assert.equal(b.stats['regex-cap'], 1);
});

test('option names that are Object.prototype keys are unknown options, not crashes', function () {
  ['constructor', 'toString', '__proto__', 'hasOwnProperty'].forEach(function (o) {
    assert.throws(function () { F.parseNetwork('||x.example^$' + o); }, o);
  });
});

test('pyJson matches json.dumps(sort_keys=True)', function () {
  assert.equal(F.pyJson(['block', 1, { b: ['x'], a: true, c: 'q"\u00e9' }]), '["block", 1, {"a": true, "b": ["x"], "c": "q\\"\\u00e9"}]');
});

test('splitLines and strip follow Python (BOM kept, \\x1c splits, trailing newline ignored)', function () {
  assert.deepEqual(F.splitLines('a\r\nb\x1cc\n'), ['a', 'b', 'c']);
  assert.equal(F.pyStrip('\ufeffx '), '\ufeffx');
});
