/*
 * "Support AdBrake" in the popup (the right-hand panel: tip link, its QR code, and the USDC / BTC
 * addresses behind a "Crypto" switch) and on the settings page (first card):
 * popup.js and options.js run against a small DOM built from the ids in their HTML files and must
 * show the tip link and the BTC and USDC addresses exactly as src/shared/donate.js holds them,
 * which must equal docs/donate.txt. Copy buttons must copy the exact value. No address or link is
 * written in this file: every expected value is read from donate.js or docs/donate.txt.
 */
loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/blocking.js', 'src/shared/stats.js',
  'src/shared/userfilters.js', 'src/shared/lists.js', 'src/shared/donate.js', 'src/shared/supportprompt.js');

var REAL_DONATE = __TAS__.donate;

/** docs/donate.txt read the way tools/build.py donate_info() reads it. */
function donateTxt() {
  var info = { url: '', usdcErc20: '', btc: '' };
  readFile('docs/donate.txt').split('\n').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.charAt(0) !== '#'; })
    .forEach(function (l) {
      var m;
      if ((m = /^usdc-erc20:\s*(\S+)$/.exec(l))) info.usdcErc20 = m[1];
      else if ((m = /^btc:\s*(\S+)$/.exec(l))) info.btc = m[1];
      else if (/^https:\/\//.test(l)) info.url = l;
    });
  return info;
}

/** id -> {tag, hidden, href, pos} for every element with an id in an HTML file. */
function htmlIds(html) {
  var out = {}, re = /<([a-zA-Z0-9]+)\b([^>]*)>/g, m;
  while ((m = re.exec(html))) {
    var id = /\sid="([^"]+)"/.exec(m[2]);
    if (!id) continue;
    var href = /\shref="([^"]*)"/.exec(m[2]);
    out[id[1]] = { tag: m[1].toLowerCase(), hidden: /\shidden(?=[\s=]|$)/.test(m[2]), href: href ? href[1] : '', pos: m.index };
  }
  return out;
}

function makeEl(id, info) {
  var e = {
    id: id, tagName: info.tag.toUpperCase(), hidden: info.hidden, href: info.href, textContent: '', title: '',
    value: '', checked: false, disabled: false, className: '', listeners: {}, children: [], attrs: {},
    addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    appendChild: function (c) { this.children.push(c); return c; },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    fire: function (t) {
      var ev = { type: t, target: this, defaultPrevented: false, preventDefault: function () { this.defaultPrevented = true; } };
      (this.listeners[t] || []).forEach(function (fn) { fn(ev); });
      return ev;
    }
  };
  return e;
}

/** Installs document/window/navigator/chrome stand-ins for the page in htmlFile; returns env. */
function installPage(htmlFile, opts) {
  opts = opts || {};
  var ids = htmlIds(readFile(htmlFile));
  var env = { els: {}, copied: [], tabsCreated: [], closed: 0, selected: null, clipboardFails: !!opts.clipboardFails };
  Object.keys(ids).forEach(function (id) { env.els[id] = makeEl(id, ids[id]); });
  globalThis.document = {
    getElementById: function (id) { return env.els[id] || null; },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    createElement: function (tag) { return makeEl('', { tag: tag, hidden: false, href: '' }); },
    createDocumentFragment: function () { return { querySelector: function () { return null; } }; },
    createRange: function () { return { node: null, selectNodeContents: function (n) { this.node = n; } }; }
  };
  globalThis.window = {
    close: function () { env.closed++; },
    getSelection: function () {
      return { removeAllRanges: function () { env.selected = null; }, addRange: function (r) { env.selected = r.node; } };
    }
  };
  globalThis.navigator = {
    clipboard: {
      writeText: function (t) {
        env.copied.push(t);
        return env.clipboardFails ? Promise.reject(new Error('denied')) : Promise.resolve();
      }
    }
  };
  globalThis.chrome = {
    runtime: {
      getManifest: function () { return { version: '0.0.0' }; },
      openOptionsPage: function () {},
      sendMessage: function () { return Promise.resolve(null); },
      getURL: function (p) { return p; }
    },
    tabs: {
      query: function () { return Promise.resolve([]); },
      create: function (o) { env.tabsCreated.push(o); return Promise.resolve({}); },
      reload: function () {}
    },
    storage: {
      local: { get: function () { return Promise.resolve({}); }, set: function () { return Promise.resolve(); } },
      session: { get: function () { return Promise.resolve({}); } },
      onChanged: { addListener: function () {} }
    },
    declarativeNetRequest: { getMatchedRules: function () { return Promise.resolve({ rulesMatchedInfo: [] }); } }
  };
  return env;
}

function runPage(htmlFile, jsFile, donate, opts) {
  var env = installPage(htmlFile, opts);
  __TAS__.donate = donate;
  try { load(jsFile); } finally { __TAS__.donate = REAL_DONATE; }
  return env;
}
function runPopup(donate, opts) { return runPage('src/popup/popup.html', 'src/popup/popup.js', donate, opts); }
function runOptions(donate, opts) { return runPage('src/options/options.html', 'src/options/options.js', donate, opts); }

function settle() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) p = p.then(function () {});
  return p;
}

// ------------------------------------------------------------------------------ sources

test('support: donate.js values equal docs/donate.txt and are all set', function () {
  var txt = donateTxt();
  assert.ok(txt.url && txt.usdcErc20 && txt.btc, 'docs/donate.txt has a link, a USDC and a BTC line');
  assert.equal(REAL_DONATE.url, txt.url, 'url');
  assert.equal(REAL_DONATE.usdcErc20, txt.usdcErc20, 'usdc');
  assert.equal(REAL_DONATE.btc, txt.btc, 'btc');
});

test('support: no address or link is written into the popup or settings page sources', function () {
  ['src/popup/popup.html', 'src/popup/popup.js', 'src/popup/popup.css',
    'src/options/options.html', 'src/options/options.js', 'src/options/options.css'].forEach(function (f) {
    var s = readFile(f);
    [REAL_DONATE.url, REAL_DONATE.usdcErc20, REAL_DONATE.btc].forEach(function (v) { assert.notIncludes(s, v, f); });
    assert.notIncludes(s, 'revolut.me', f);
    if (/\.js$/.test(f)) assert.notIncludes(s, 'innerHTML', f);
  });
});

// ------------------------------------------------------------------------------ layout

test('support: popup support panel sits beside the main panel; no footer link', function () {
  var html = readFile('src/popup/popup.html');
  var panel = html.indexOf('id="support"');
  assert.ok(panel > html.indexOf('</header>'), 'after the header');
  assert.ok(panel > html.indexOf('class="card site"'), 'after the site card');
  assert.ok(html.indexOf('class="panel main-panel"') < panel, 'main panel first (left)');
  assert.includes(html.slice(html.lastIndexOf('<', panel), panel), '<aside class="panel support"', 'support is its own panel');
  assert.equal(html.indexOf('id="support"', panel + 1), -1, 'one support element only');
  var footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  assert.notIncludes(footer, 'support', 'footer has no support link');
});

test('support: popup has the tip link, the phone QR inline and both coins with their QR codes', function () {
  var html = readFile('src/popup/popup.html');
  assert.includes(html, 'Card · Apple Pay · Google Pay');
  ['../assets/qr/revolut.svg', '../assets/qr/usdc.svg', '../assets/qr/btc.svg'].forEach(function (s) { assert.includes(html, s); });
  ['tab-phone', 'tab-usdc', 'tab-btc', 'coin-usdc', 'coin-btc', 'usdc-address', 'btc-address', 'usdc-copy', 'btc-copy',
    'usdc-note', 'btc-note'].forEach(function (id) { assert.includes(html, 'id="' + id + '"', id); });
  assert.includes(html, 'role="tablist"');
  ['qr-sheet', 'qr-open', 'prompt-later', 'prompt-support', 'sheet-backdrop'].forEach(function (s) {
    assert.notIncludes(html, s, 'old sheet markup gone: ' + s);
  });
  assert.notIncludes(html, 'Revolut', 'no payment-provider name in the popup UI');
});

test('support: settings page shows #support as the first card', function () {
  var html = readFile('src/options/options.html');
  var support = html.indexOf('id="support"');
  assert.ok(support > html.indexOf('</header>'), 'after the header');
  var firstCard = html.indexOf('<section class="card');
  assert.ok(firstCard >= 0, 'has cards');
  assert.includes(html.slice(firstCard, html.indexOf('>', firstCard)), 'id="support"', 'first <section class="card"> is #support');
  assert.includes(html, 'BTC · Bitcoin network');
  assert.includes(html, 'USDC · Ethereum (ERC-20) only');
});

// ------------------------------------------------------------------------------ popup.js

test('support: popup shows the tip link exactly as donate.js and donate.txt', function () {
  var env = runPopup(REAL_DONATE);
  var e = env.els;
  assert.equal(e['support'].hidden, false, 'card shown');
  assert.equal(e['support-revolut'].hidden, false, 'link row');
  assert.equal(e['support-link'].href, REAL_DONATE.url);
  assert.equal(e['support-link'].href, donateTxt().url);
  assert.equal(e['support-phone'].hidden, false, 'Pay with phone shown inline');
  assert.equal(e['layout'].className, 'layout', 'two panels');
  return settle();
});

test('support: popup shows both addresses shortened from donate.js, full in the title, with the notes', function () {
  var env = runPopup(REAL_DONATE);
  var e = env.els;
  assert.equal(e['support-crypto'].hidden, false, 'crypto shown');
  [['usdc', REAL_DONATE.usdcErc20, REAL_DONATE.usdcNote], ['btc', REAL_DONATE.btc, REAL_DONATE.btcNote]].forEach(function (c) {
    var shown = e[c[0] + '-address'].textContent;
    assert.equal(shown, c[1].slice(0, 6) + '…' + c[1].slice(-4), c[0] + ' shortened');
    assert.equal(e[c[0] + '-address'].title, c[1], c[0] + ' full address in the title');
    assert.includes(e[c[0] + '-address'].getAttribute('aria-label'), c[1]);
    assert.equal(e[c[0] + '-note'].textContent, c[2], c[0] + ' network warning');
    assert.equal(e['tab-' + c[0]].hidden, false, c[0] + ' tab shown');
  });
  assert.equal(e['usdc-address'].title, donateTxt().usdcErc20);
  assert.equal(e['btc-address'].title, donateTxt().btc);
  return settle();
});

var VIEW_OF = { phone: 'support-phone', usdc: 'coin-usdc', btc: 'coin-btc' };

/** Exactly one support view shown (`key`), its tab selected and focusable, the others not. */
function assertView(e, key, msg) {
  Object.keys(VIEW_OF).forEach(function (k) {
    var on = k === key;
    assert.equal(e[VIEW_OF[k]].hidden, !on, (msg || '') + ' ' + k + (on ? ' shown' : ' hidden'));
    assert.equal(e['tab-' + k].getAttribute('aria-selected'), on ? 'true' : 'false', (msg || '') + ' tab-' + k + ' selected');
    assert.equal(e['tab-' + k].tabIndex, on ? 0 : -1, (msg || '') + ' tab-' + k + ' tabIndex');
  });
}

function arrow(el, key) {
  var ev = { type: 'keydown', key: key, target: el, preventDefault: function () { this.p = true; } };
  el.listeners.keydown.forEach(function (fn) { fn(ev); });
  return ev;
}

test('support: popup Phone | USDC | BTC control shows one QR code at a time (click and arrow keys)', function () {
  var env = runPopup(REAL_DONATE);
  var e = env.els;
  ['phone', 'usdc', 'btc'].forEach(function (k) { assert.equal(e['tab-' + k].hidden, false, 'tab-' + k + ' shown'); });
  assert.includes(readFile('src/popup/popup.html'), 'aria-controls="support-phone"');
  assertView(e, 'phone', 'Phone first:');
  e['tab-btc'].fire('click');
  assertView(e, 'btc', 'after a click on BTC:');
  e['tab-usdc'].fire('click');
  assertView(e, 'usdc', 'after a click on USDC:');
  assert.ok(arrow(e['tab-usdc'], 'ArrowRight').p, 'arrow handled');
  assertView(e, 'btc', 'ArrowRight:');
  arrow(e['tab-btc'], 'ArrowRight');
  assertView(e, 'phone', 'ArrowRight wraps:');
  arrow(e['tab-phone'], 'ArrowLeft');
  assertView(e, 'btc', 'ArrowLeft wraps back:');
  arrow(e['tab-btc'], 'Home');
  assertView(e, 'phone', 'Home:');
  arrow(e['tab-phone'], 'End');
  assertView(e, 'btc', 'End:');
  var other = arrow(e['tab-btc'], 'a');
  assert.notOk(other.p, 'other keys left alone');
  return settle();
});

/** Runs popup.js on a Twitch channel tab with the page script loaded (the Twitch row shows). */
function runPopupOnTwitch(donate) {
  var env = installPage('src/popup/popup.html');
  var tw = { detected: 2, backup: 1, stripped: 1, standalone: 0, failures: 0 };
  chrome.tabs.query = function () { return Promise.resolve([{ id: 9, url: 'https://www.twitch.tv/somechannel' }]); };
  chrome.tabs.sendMessage = function (id, msg, o, cb) { cb({ pageHooked: true, degraded: [] }); };
  chrome.runtime.sendMessage = function (m) {
    return Promise.resolve(m && m.type === 'popup-get-state' ? { tab: { stats: tw, degraded: false, lastEvent: null }, lifetime: tw } : null);
  };
  __TAS__.donate = donate;
  try { load('src/popup/popup.js'); } finally { __TAS__.donate = REAL_DONATE; }
  return env;
}

// 2.0.3 on Twitch: the crypto part of the support panel was cut off below the popup (a CSS
// height problem; tests/test_popup_layout.py checks the rendered layout). Here: on a Twitch tab
// every support view is still in the page and reachable from the Phone | USDC | BTC control.
test('support: on a Twitch tab the Twitch row shows and Phone, USDC and BTC stay present and reachable', function () {
  var env = runPopupOnTwitch(REAL_DONATE);
  var e = env.els;
  return settle().then(settle).then(function () {
    assert.equal(e['twitch'].hidden, false, 'Twitch row shown');
    assert.equal(e['status-text'].textContent, 'Active on this tab');
    assert.equal(e['support'].hidden, false, 'support panel shown');
    assert.equal(e['support-crypto'].hidden, false, 'crypto views present');
    assert.equal(e['support-revolut'].hidden, false, 'card button present');
    ['phone', 'usdc', 'btc'].forEach(function (k) {
      assert.equal(e['tab-' + k].hidden, false, 'tab-' + k + ' shown on Twitch');
      e['tab-' + k].fire('click');
      assertView(e, k, 'on Twitch, ' + k + ':');
    });
    assert.equal(e['usdc-address'].title, REAL_DONATE.usdcErc20);
    assert.equal(e['btc-address'].title, REAL_DONATE.btc);
    arrow(e['tab-btc'], 'ArrowRight');
    assertView(e, 'phone', 'on Twitch, arrows wrap:');
  });
});

// The stat numbers pop when a count arrives or changes (popup.css .bump); the class is restarted
// on each change (setCount skips an unchanged value).
test('popup: a stat number gets the .bump class when its count arrives', function () {
  var env = installPage('src/popup/popup.html');
  var classes = function () {
    var set = [];
    return { list: set, add: function (c) { if (set.indexOf(c) < 0) set.push(c); },
      remove: function (c) { var i = set.indexOf(c); if (i >= 0) set.splice(i, 1); } };
  };
  ['g-ads', 'g-trackers', 'g-cookies', 'g-banners'].forEach(function (id) { env.els[id].classList = classes(); env.els[id].textContent = '\u2013'; });
  chrome.tabs.query = function () { return Promise.resolve([{ id: 4, url: 'https://news.example.com/' }]); };
  chrome.declarativeNetRequest.getMatchedRules = function () {
    return Promise.resolve({ rulesMatchedInfo: [{ rule: { ruleId: 1, rulesetId: 'ads_1' } }, { rule: { ruleId: 2, rulesetId: 'ads_1' } }] });
  };
  load('src/popup/popup.js');
  return settle().then(settle).then(function () {
    var e = env.els;
    assert.equal(e['g-ads'].textContent, '2');
    assert.deepEqual(e['g-ads'].classList.list, ['bump'], 'ads count arrived: pops');
    assert.equal(e['g-trackers'].textContent, '0');
    assert.deepEqual(e['g-trackers'].classList.list, ['bump'], '0 replaces the dash: pops');
  });
});

test('support: popup Copy copies the full donate.js address and says "Copied ✓" for 1.5 s', function () {
  var env = runPopup(REAL_DONATE);
  var e = env.els;
  e['usdc-copy'].fire('click');
  e['btc-copy'].fire('click');
  assert.deepEqual(env.copied, [REAL_DONATE.usdcErc20, REAL_DONATE.btc]);
  assert.deepEqual(env.copied, [donateTxt().usdcErc20, donateTxt().btc]);
  return settle().then(function () {
    assert.equal(e['usdc-copy-label'].textContent, 'Copied ✓');
    assert.equal(e['btc-copy-label'].textContent, 'Copied ✓');
    __advanceTimers(1400);
    assert.equal(e['usdc-copy-label'].textContent, 'Copied ✓', 'still shown before 1.5 s');
    __advanceTimers(200);
    assert.equal(e['usdc-copy-label'].textContent, 'Copy', 'back after 1.5 s');
    assert.equal(e['btc-copy-label'].textContent, 'Copy');
  });
});

test('support: popup Copy failure does not claim success', function () {
  var env = runPopup(REAL_DONATE, { clipboardFails: true });
  env.els['btc-copy'].fire('click');
  assert.deepEqual(env.copied, [REAL_DONATE.btc]);
  return settle().then(function () {
    assert.ok(env.els['btc-copy-label'].textContent !== 'Copied ✓');
    __advanceTimers(2000);
    assert.equal(env.els['btc-copy-label'].textContent, 'Copy');
  });
});

test('support: popup tip link opens a new tab with the donate.js link and closes the popup', function () {
  var env = runPopup(REAL_DONATE);
  var ev = env.els['support-link'].fire('click');
  assert.ok(ev.defaultPrevented, 'default prevented');
  assert.deepEqual(env.tabsCreated, [{ url: REAL_DONATE.url }]);
  return settle().then(function () { assert.equal(env.closed, 1, 'popup closed'); });
});

test('support: popup panel follows donate.js: crypto alone shows it, nothing set hides it', function () {
  var env = runPopup({ url: '', usdcErc20: REAL_DONATE.usdcErc20, btc: '' });
  assert.equal(env.els['support'].hidden, false, 'panel shown for crypto');
  assert.equal(env.els['support-revolut'].hidden, true, 'no tip link row');
  assert.equal(env.els['tab-btc'].hidden, true, 'no BTC tab without an address');
  assert.equal(env.els['tab-phone'].hidden, true, 'no Phone tab without a link');
  assert.equal(env.els['support-phone'].hidden, true, 'no phone QR without a link');
  assert.equal(env.els['coin-usdc'].hidden, false, 'USDC shown first');
  assert.equal(env.els['tab-usdc'].getAttribute('aria-selected'), 'true');
  var link = runPopup({ url: REAL_DONATE.url, usdcErc20: '', btc: '' });
  assert.equal(link.els['support-crypto'].hidden, true, 'no crypto views without addresses');
  assert.equal(link.els['tab-usdc'].hidden, true);
  assert.equal(link.els['support-phone'].hidden, false, 'phone QR shown');
  assert.equal(link.els['tab-phone'].getAttribute('aria-selected'), 'true');
  var none = runPopup({ url: '', usdcErc20: '', btc: '' });
  assert.equal(none.els['support'].hidden, true, 'hidden when nothing is set');
  assert.equal(none.els['support-crypto'].hidden, true);
  assert.equal(none.els['layout'].className, 'layout single', 'one column');
  var missing = runPopup(undefined);
  assert.equal(missing.els['support'].hidden, true, 'panel hidden without donate.js');
  return settle();
});

// ------------------------------------------------------------------------------ options.js

test('support: settings page shows the link and both addresses exactly as donate.js and donate.txt', function () {
  var env = runOptions(REAL_DONATE);
  var txt = donateTxt();
  var e = env.els;
  assert.equal(e['support'].hidden, false, 'card shown');
  assert.equal(e['support-revolut'].hidden, false);
  assert.equal(e['support-btc'].hidden, false);
  assert.equal(e['support-usdc'].hidden, false);
  assert.equal(e['support-link'].href, REAL_DONATE.url);
  assert.equal(e['btc-address'].textContent, REAL_DONATE.btc);
  assert.equal(e['usdc-address'].textContent, REAL_DONATE.usdcErc20);
  assert.equal(e['support-link'].href, txt.url);
  assert.equal(e['btc-address'].textContent, txt.btc);
  assert.equal(e['usdc-address'].textContent, txt.usdcErc20);
  assert.equal(e['btc-note'].textContent, REAL_DONATE.btcNote);
  assert.equal(e['usdc-note'].textContent, REAL_DONATE.usdcNote);
  return settle();
});

test('support: settings page shows addresses shortened, keeps the full text, toggles the QR codes', function () {
  var env = runOptions(REAL_DONATE);
  var e = env.els;
  assert.equal(e['support-crypto'].hidden, false, 'crypto section');
  ['btc', 'usdc'].forEach(function (id) {
    var full = id === 'btc' ? REAL_DONATE.btc : REAL_DONATE.usdcErc20;
    var short = e[id + '-address'].getAttribute('data-short');
    assert.ok(short.length < full.length && short.indexOf('…') > 0, id + ' shortened');
    assert.equal(short.slice(0, 8), full.slice(0, 8));
    assert.equal(short.slice(-6), full.slice(-6));
    assert.equal(e[id + '-qr'].hidden, true, id + ' QR hidden at first');
    e[id + '-qr-toggle'].fire('click');
    assert.equal(e[id + '-qr'].hidden, false, id + ' QR shown');
    assert.equal(e[id + '-qr-toggle'].getAttribute('aria-expanded'), 'true');
    e[id + '-qr-toggle'].fire('click');
    assert.equal(e[id + '-qr'].hidden, true, id + ' QR hidden again');
  });
  return settle();
});

test('support: settings page copy buttons copy the exact address', function () {
  var env = runOptions(REAL_DONATE);
  env.els['btc-copy'].fire('click');
  env.els['usdc-copy'].fire('click');
  assert.deepEqual(env.copied, [REAL_DONATE.btc, REAL_DONATE.usdcErc20]);
  assert.deepEqual(env.copied, [donateTxt().btc, donateTxt().usdcErc20]);
  return settle().then(function () {
    assert.equal(env.els['btc-copied'].textContent, 'Copied ✓');
    __advanceTimers(5000);
  });
});

test('support: settings page hides the card when nothing is set', function () {
  var env = runOptions({ url: '', usdcErc20: '', btc: '' });
  assert.equal(env.els['support'].hidden, true);
  return settle();
});

// ------------------------------------------------------------------------------ support note (popup)

/** Runs popup.js on a web tab with `ads` blocked on the page and `store` as chrome.storage.local. */
function runPopupWithTab(store, ads) {
  var env = installPage('src/popup/popup.html');
  env.store = store;
  chrome.runtime.getManifest = function () { return { version: '2.0.3' }; };
  chrome.tabs.query = function () { return Promise.resolve([{ id: 7, url: 'https://news.example/' }]); };
  chrome.storage.local.get = function (keys) {
    var out = {};
    [].concat(keys).forEach(function (k) { if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); });
    return Promise.resolve(out);
  };
  chrome.storage.local.set = function (o) { Object.keys(o).forEach(function (k) { store[k] = o[k]; }); return Promise.resolve(); };
  chrome.storage.session.get = function () { return Promise.resolve({ 'page:7': { t: 1234 } }); };
  chrome.declarativeNetRequest.getMatchedRules = function () {
    var infos = [];
    for (var i = 0; i < ads; i++) infos.push({ rule: { ruleId: 10 + i, rulesetId: 'ads_1' } });
    return Promise.resolve({ rulesMatchedInfo: infos });
  };
  __TAS__.donate = REAL_DONATE;
  load('src/popup/popup.js');
  return env;
}

test('support note: at the first milestone the support panel glows once with "at least" the counted ads', function () {
  var SP = __TAS__.supportPrompt;
  var store = {};
  store[SP.INSTALL_KEY] = Date.now() - 30 * SP.DAY;
  store[SP.SEEN_KEY] = { total: 990, lastKey: 'old', lastCount: 4 };
  store[SP.STATE_KEY] = { version: '2.0.3' };
  var env = runPopupWithTab(store, 20);
  return settle().then(settle).then(function () {
    assert.equal(env.els['support-prompt'].hidden, false, 'thank-you line shown');
    assert.equal(env.els['support'].className, 'panel support highlight', 'panel highlighted');
    assert.includes(env.els['prompt-text'].textContent, 'at least 1,010 ads');
    assert.equal(env.els['prompt-text'].textContent, SP.thanks(1010));
    assert.equal(store[SP.SEEN_KEY].total, 1010);
    assert.equal(store[SP.STATE_KEY].lastMilestone, 1000, 'milestone used up');
    assert.ok(store[SP.STATE_KEY].lastShownAt > 0, 'shown time stored');
    assert.deepEqual(env.tabsCreated, [], 'no tab opened by itself');
    env.els['prompt-never'].fire('click');
    return settle();
  }).then(function () {
    assert.equal(env.els['support-prompt'].hidden, true, 'Don\u2019t remind me hides the line');
    assert.equal(env.els['support'].className, 'panel support', 'glow removed');
    assert.equal(store[SP.STATE_KEY].never, true, 'turned off');
    assert.equal(store[SP.STATE_KEY].reminders, false);
  });
});

test('support note: below the milestone the panel is not highlighted', function () {
  var SP = __TAS__.supportPrompt;
  var store = {};
  store[SP.INSTALL_KEY] = Date.now() - 30 * SP.DAY;
  store[SP.SEEN_KEY] = { total: 100 };
  store[SP.STATE_KEY] = { version: '2.0.3' };
  var env = runPopupWithTab(store, 5);
  return settle().then(settle).then(function () {
    assert.equal(env.els['support-prompt'].hidden, true, 'no line');
    assert.ok(env.els['support'].className !== 'panel support highlight', 'no glow');
    assert.equal(store[SP.SEEN_KEY].total, 105);
  });
});

test('support note: not on the first popup open after an update; older installs get an install date', function () {
  var SP = __TAS__.supportPrompt;
  var store = {};
  store[SP.SEEN_KEY] = { total: 50000 };
  store[SP.STATE_KEY] = { version: '2.0.2' };
  var env = runPopupWithTab(store, 3);
  return settle().then(settle).then(function () {
    assert.equal(env.els['support-prompt'].hidden, true, 'not shown');
    assert.ok(env.els['support'].className !== 'panel support highlight', 'no glow');
    assert.equal(store[SP.STATE_KEY].version, '2.0.3', 'version noted');
    assert.ok(store[SP.INSTALL_KEY] > 0, 'install date set now');
    assert.equal(store[SP.SEEN_KEY].total, 50003);
  });
});
