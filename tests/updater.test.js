/*
 * src/background/updater.js against a fake chrome.* and fetch: the fixture lists stand in for the
 * downloads, a synthetic build-info.json for the packaged lists, and a stub general.installLists /
 * resetLists records what would be applied (general.test.js covers those against DNR).
 */
globalThis.self = globalThis;
globalThis.console = globalThis.console || { log: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 80; i++) p = p.then(function () {});
  return p;
}

globalThis.AbortController = function () { this.signal = { aborted: false }; this.abort = function () { this.signal.aborted = true; }; };
var BASE = 'chrome-extension://test-id/';
var local = {}, alarms = {}, fetches = [], installs = [], resets = [];
var listeners = { message: [], installed: [], startup: [], storage: [], alarm: [] };
var FIX = { easylist: fixture('lists/easylist.txt'), easyprivacy: fixture('lists/easyprivacy.txt'), cookie: fixture('lists/easylist-cookie.txt') };
var serve = {};
function resetServe() {
  serve = {
    'https://easylist.to/easylist/easylist.txt': { status: 200, text: FIX.easylist },
    'https://easylist.to/easylist/easyprivacy.txt': { status: 200, text: FIX.easyprivacy },
    'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt': { status: 200, text: FIX.cookie }
  };
}
resetServe();
var buildInfo = {
  lists: { easylist: { version: '202611010000' }, easyprivacy: { version: '202611010000' }, 'easylist-cookie': { version: '2026-11-01 00:00 UTC' } },
  rulesets: { ads_1: { rules: 80 }, privacy_1: { rules: 20 }, cookies_1: { rules: 8 }, ads_curated: { rules: 1 } }
};
var regexSupported = true;
var dnr = {
  MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, MAX_NUMBER_OF_REGEX_RULES: 1000,
  isRegexSupported: function () { return Promise.resolve({ isSupported: regexSupported }); }
};

globalThis.chrome = {
  runtime: {
    id: 'test-id',
    getURL: function (p) { return BASE + p; },
    onMessage: { addListener: function (fn) { listeners.message.push(fn); } },
    onInstalled: { addListener: function (fn) { listeners.installed.push(fn); } },
    onStartup: { addListener: function (fn) { listeners.startup.push(fn); } }
  },
  storage: {
    local: {
      get: function (keys) {
        var o = {};
        [].concat(keys).forEach(function (k) { if (local[k] !== undefined) o[k] = JSON.parse(JSON.stringify(local[k])); });
        return Promise.resolve(o);
      },
      set: function (o) {
        var ch = {};
        Object.keys(o).forEach(function (k) { ch[k] = { newValue: o[k] }; local[k] = JSON.parse(JSON.stringify(o[k])); });
        listeners.storage.forEach(function (fn) { fn(ch, 'local'); });
        return Promise.resolve();
      }
    },
    onChanged: { addListener: function (fn) { listeners.storage.push(fn); } }
  },
  alarms: {
    get: function (n) { return Promise.resolve(alarms[n]); },
    create: function (n, o) { alarms[n] = Object.assign({ name: n }, o); },
    clear: function (n) { var had = !!alarms[n]; delete alarms[n]; return Promise.resolve(had); },
    onAlarm: { addListener: function (fn) { listeners.alarm.push(fn); } }
  },
  declarativeNetRequest: dnr
};
globalThis.fetch = function (url, opts) {
  url = String(url);
  if (url.indexOf(BASE) === 0) {
    var path = url.slice(BASE.length);
    var body = path === 'rules/build-info.json' ? buildInfo : path === 'rules/cosmetic/generic.json' ? { ads: ['.old-generic'], cookies: [] } : null;
    return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(JSON.stringify(body))); } });
  }
  fetches.push({ url: url, opts: opts });
  var s = serve[url];
  if (!s) return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({
    status: s.status, url: url, headers: { get: function () { return null; } },
    text: function () { return Promise.resolve(s.text); }
  });
};

loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/logger.js', 'src/shared/blocking.js', 'src/shared/filterlist.js', 'src/shared/lists.js');
var B = __TAS__.blocking;
var installFails = false;
__TAS__.general = {
  installLists: function (data) {
    installs.push(data);
    if (installFails) return Promise.reject(new Error('quota exceeded'));
    return chrome.storage.local.set({ listRules: data.rules, listSite: data.site, lists: data.meta });
  },
  resetLists: function (meta) { resets.push(meta); return chrome.storage.local.set({ lists: meta }); }
};
load('src/background/updater.js');
var U = __TAS__.updater;

var OPTIONS = { id: 'test-id', url: BASE + 'src/options/options.html', tab: { id: 3 } };
function send(msg, sender) {
  return new Promise(function (resolve) {
    var answered = false;
    listeners.message.forEach(function (fn) {
      var r = fn(msg, sender || OPTIONS, function (x) { answered = true; resolve(x); });
      if (r !== true && !answered) resolve('ignored');
    });
  });
}
function bump(text, from, to) { return text.replace(from, to); }

test('only extension pages may use the list messages', function () {
  assert.ok(U.fromExtensionPage(OPTIONS));
  assert.ok(U.fromExtensionPage({ id: 'test-id', url: BASE + 'src/popup/popup.html' }), 'popup: no tab');
  assert.notOk(U.fromExtensionPage({ id: 'test-id', url: 'https://evil.example/', tab: { id: 1 } }), 'content script');
  assert.notOk(U.fromExtensionPage({ id: 'test-id', url: BASE + 'src/popup/popup.html', tab: { id: 1 } }), 'other page in a tab');
  assert.notOk(U.fromExtensionPage({ id: 'other', url: BASE + 'src/options/options.html' }));
  return send({ type: 'as-lists-update-now' }, { id: 'test-id', url: 'https://evil.example/', tab: { id: 1 } }).then(function (r) {
    assert.equal(r, 'ignored');
    assert.equal(fetches.length, 0);
  });
});

test('install: weekly alarm, and a check soon because the packaged lists are over a week old', function () {
  listeners.installed.forEach(function (fn) { fn({ reason: 'install' }); });
  return flush().then(function () {
    assert.equal(alarms['as-lists-weekly'].periodInMinutes, 7 * 24 * 60);
    assert.equal(alarms['as-lists-soon'].delayInMinutes, 1);
  });
});

test('Update now: fetches exactly the three list URLs (no credentials, no cache), installs dynamic rules', function () {
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    assert.deepEqual(r.ok, true, JSON.stringify(r));
    assert.deepEqual(fetches.map(function (f) { return f.url; }).sort(), Object.keys(serve).sort());
    fetches.forEach(function (f) {
      assert.equal(f.opts.credentials, 'omit');
      assert.equal(f.opts.cache, 'no-cache');
      assert.ok(f.opts.signal, 'abortable (timeout)');
    });
    var d = installs[0];
    ['ads', 'trackers', 'hideCookieBanners'].forEach(function (f) {
      assert.ok(d.rules[f].length > 0, f);
      d.rules[f].forEach(function (rule) { assert.equal(B.dynamicFeature(rule.id), f, f + ' id ' + rule.id); });
    });
    assert.ok(d.rules.ads.some(function (x) { return x.id > 1500000; }), 'allow rules in the allow range');
    assert.equal(d.site.v, 1);
    assert.equal(local.lists.source, 'updated');
    assert.equal(local.lists.lists.easylist.version, '202611100000');
    assert.equal(local.lists.lists.easylist.rules, d.rules.ads.length);
  });
});

test('same versions again: up to date, nothing installed', function () {
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    assert.equal(r.ok, true);
    assert.includes(r.message, 'up to date');
    assert.equal(installs.length, 1);
    assert.equal(local.lists.source, 'updated');
  });
});

test('one list fails to download: nothing applied, error recorded for that list', function () {
  serve['https://easylist.to/easylist/easyprivacy.txt'] = { status: 503, text: '' };
  serve['https://easylist.to/easylist/easylist.txt'].text = bump(FIX.easylist, '202611100000', '202611200000');
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    assert.equal(r.ok, false);
    assert.equal(installs.length, 1);
    assert.includes(local.lists.lists.easyprivacy.error, 'HTTP 503');
    assert.equal(local.lists.lists.easylist.version, '202611100000', 'version in use kept');
    resetServe();
  });
});

test('too few rules or an older version: nothing applied', function () {
  serve['https://easylist.to/easylist/easylist.txt'].text = '! Version: 202611200000\n||only.example^\n';
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    assert.equal(r.ok, false);
    assert.includes(local.lists.lists.easylist.error, 'only 1 rules');
    resetServe();
    serve['https://easylist.to/easylist/easylist.txt'].text = bump(FIX.easylist, '202611100000', '202611050000');
    return send({ type: 'as-lists-update-now' });
  }).then(function (r) {
    assert.equal(r.ok, false);
    assert.includes(local.lists.lists.easylist.error, 'older');
    assert.equal(installs.length, 1);
    resetServe();
  });
});

test('rules that do not fit this Chrome: nothing applied', function () {
  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = 50;
  serve['https://easylist.to/easylist/easylist.txt'].text = bump(FIX.easylist, '202611100000', '202611200000');
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    dnr.MAX_NUMBER_OF_DYNAMIC_RULES = 30000;
    assert.equal(r.ok, false);
    assert.includes(r.message, 'do not fit');
    assert.equal(installs.length, 1);
  });
});

test('regex rules Chrome cannot compile are dropped; Chrome refusing the rules keeps the old state', function () {
  regexSupported = false;
  installFails = true;
  return send({ type: 'as-lists-update-now' }).then(function (r) {
    regexSupported = true;
    installFails = false;
    assert.equal(installs.length, 2);
    ['ads', 'trackers', 'hideCookieBanners'].forEach(function (f) {
      assert.notOk(installs[1].rules[f].some(function (x) { return x.condition.regexFilter; }), f);
    });
    assert.equal(r.ok, false);
    assert.includes(r.message, 'quota exceeded');
    assert.equal(local.lists.lists.easylist.version, '202611100000');
    return send({ type: 'as-lists-update-now' });
  }).then(function (r) {
    assert.equal(r.ok, true);
    assert.equal(local.lists.lists.easylist.version, '202611200000');
    resetServe();
  });
});

test('status for the options page', function () {
  return send({ type: 'as-lists-status' }).then(function (s) {
    assert.equal(s.rows.length, 3);
    assert.equal(s.rows[0].version, '202611200000');
    assert.equal(s.rows[0].status, 'updated');
    assert.equal(s.running, false);
    assert.equal(s.autoUpdateLists, true);
  });
});

test('alarm: no download when not due', function () {
  var n = fetches.length;
  return U.onAlarm({ name: 'as-lists-weekly' }).then(function () {
    assert.equal(fetches.length, n);
  });
});

test('auto-update off: alarms cleared, no download on an alarm; existing lists stay', function () {
  return chrome.storage.local.set({ blocking: Object.assign(B.defaults(), { autoUpdateLists: false }) }).then(flush).then(function () {
    assert.equal(alarms['as-lists-weekly'], undefined);
    assert.equal(alarms['as-lists-soon'], undefined);
    local.lists.lastCheck = 0;
    var n = fetches.length;
    return U.onAlarm({ name: 'as-lists-weekly' }).then(function () {
      assert.equal(fetches.length, n);
      assert.equal(local.lists.source, 'updated');
    });
  });
});

test('"Use built-in lists" resets to the packaged lists', function () {
  return send({ type: 'as-lists-reset' }).then(function (r) {
    assert.equal(r.ok, true);
    assert.equal(resets.length, 1);
    assert.equal(local.lists.source, 'packaged');
  });
});

test('extension update with newer packaged lists falls back to them', function () {
  local.lists = { source: 'updated', lastCheck: Date.now(), lists: { easylist: { version: '202611200000' }, easyprivacy: { version: '202611100010' }, 'easylist-cookie': { version: '2026-11-10 08:30 UTC' } } };
  buildInfo.lists.easyprivacy.version = '202611150000';
  listeners.installed.forEach(function (fn) { fn({ reason: 'update' }); });
  return flush().then(function () {
    assert.equal(resets.length, 2);
    assert.equal(local.lists.source, 'packaged');
  });
});
