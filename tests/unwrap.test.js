/*
 * rules/unwrap.json (built from rules/unwrap.txt by tools/unwrap.py): link unwrapping by DNR
 * redirect.regexSubstitution. Each rule's regexFilter / regexSubstitution is applied here with
 * the JavaScript engine (\1 -> $1, case-insensitive like DNR) to the test and miss URLs written
 * in rules/unwrap.txt, independent of the Python checker.
 */

var RULES = JSON.parse(readFile('rules/unwrap.json'));
var ENTRIES = (function () {
  var out = [], cur = null;
  readFile('rules/unwrap.txt').split('\n').forEach(function (raw) {
    var line = raw.trim();
    if (!line || line.charAt(0) === '#') return;
    var m = /^(\S+)\s+(.*)$/.exec(line);
    if (m[1] === 'rule') { cur = { name: m[2], tests: [], misses: [] }; out.push(cur); }
    else if (m[1] === 'test') { var p = m[2].split(' => '); cur.tests.push([p[0].trim(), p[1].trim()]); }
    else if (m[1] === 'miss') cur.misses.push(m[2].trim());
  });
  return out;
})();

/** One DNR redirect step for a top-level page load: [rule id, new URL] or null. */
function step(url) {
  for (var i = 0; i < RULES.length; i++) {
    var r = RULES[i];
    var re = new RegExp(r.condition.regexFilter, 'i');
    if (!re.test(url)) continue;
    var sub = r.action.redirect.regexSubstitution.replace(/\\(\d)/g, '$$$1');
    return [r.id, url.replace(re, sub)];
  }
  return null;
}

/** Follow redirects like the browser does; fails after 3 hops (a loop). */
function follow(url) {
  for (var hops = 0; hops < 4; hops++) {
    var s = step(url);
    if (!s) return url;
    url = s[1];
  }
  throw new Error('redirect loop from ' + url);
}

function plainHttps(url) {
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(url);
}

test('one rule per entry, page loads only, https targets, anchored filters', function () {
  assert.equal(RULES.length, ENTRIES.length);
  assert.equal(RULES.length, 4);
  RULES.forEach(function (r) {
    assert.deepEqual(r.condition.resourceTypes, ['main_frame'], 'rule ' + r.id);
    assert.equal(r.action.type, 'redirect');
    assert.ok(r.action.redirect.regexSubstitution.indexOf('https://') === 0, 'rule ' + r.id + ' https only');
    assert.ok(/^\^https\?:\/\//.test(r.condition.regexFilter), 'rule ' + r.id + ' anchored at the start');
    assert.ok(/\$$/.test(r.condition.regexFilter), 'rule ' + r.id + ' anchored at the end');
    assert.ok(r.priority > 50 && r.priority < 100, 'above removeparam (50), below the allowlist (100)');
  });
});

test('sample AMP and redirect-hop URLs land on the real page', function () {
  var n = 0;
  ENTRIES.forEach(function (e, i) {
    e.tests.forEach(function (t) {
      var first = step(t[0]);
      assert.ok(first, e.name + ': ' + t[0] + ' is redirected');
      assert.equal(first[0], RULES[i].id, e.name + ': by its own rule');
      var got = follow(t[0]);
      assert.equal(got, t[1], e.name + ': ' + t[0]);
      assert.ok(plainHttps(got), got + ' is a plain https URL');
      assert.equal(step(got), null, got + ' is not redirected again');
      n++;
    });
  });
  assert.ok(n >= 10, 'enough samples (' + n + ')');
});

test('look-alikes, other paths and unsafe hosts are left alone', function () {
  var n = 0;
  ENTRIES.forEach(function (e) {
    e.misses.forEach(function (u) { assert.equal(step(u), null, e.name + ': ' + u); n++; });
  });
  assert.ok(n >= 15, 'enough misses (' + n + ')');
  // Case does not matter to DNR (isUrlFilterCaseSensitive defaults to false), nor here.
  assert.equal(follow('HTTPS://WWW.GOOGLE.COM/amp/s/Example.COM/Path'), 'https://Example.COM/Path');
});

test('known AMP examples from both sources', function () {
  assert.equal(follow('https://www.google.com/amp/s/www.example.com/amp/story.html'), 'https://www.example.com/amp/story.html');
  assert.equal(follow('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/amp/story.html'), 'https://www.example.com/amp/story.html');
  assert.equal(follow('https://www.google.com/amp/s/www-example-com.cdn.ampproject.org/c/s/www.example.com/'), 'https://www.example.com/',
    'nested AMP wrappers unwrap in two hops');
  assert.equal(step('https://www.google.com/amp/s/example.com@evil.example/'), null, 'user@host is never produced');
  assert.equal(step('https://www.google.com/amp/s/data:text/html,x'), null);
});
