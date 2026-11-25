/*
 * "Support Ad Shield" in the popup (card under the header) and on the settings page (first card):
 * popup.js and options.js run against a small DOM built from the ids in their HTML files and must
 * show the tip link and the BTC and USDC addresses exactly as src/shared/donate.js holds them,
 * which must equal docs/donate.txt. Copy buttons must copy the exact value. No address or link is
 * written in this file: every expected value is read from donate.js or docs/donate.txt.
 */
loadSrc('src/config.js', 'src/shared/settings.js', 'src/shared/blocking.js', 'src/shared/stats.js',
  'src/shared/userfilters.js', 'src/shared/lists.js', 'src/shared/donate.js');

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

test('support: popup card sits under the header, before the site card; no footer link', function () {
  var html = readFile('src/popup/popup.html');
  var card = html.indexOf('id="support"');
  assert.ok(card > html.indexOf('</header>'), 'after the header');
  assert.ok(card < html.indexOf('class="card site"'), 'before the site card');
  assert.equal(html.indexOf('id="support"', card + 1), -1, 'one support element only');
  var footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  assert.notIncludes(footer, 'support', 'footer has no support link');
});

test('support: popup labels name the networks', function () {
  var html = readFile('src/popup/popup.html');
  assert.includes(html, 'BTC · Bitcoin network');
  assert.includes(html, 'USDC · Ethereum (ERC-20) only');
  assert.includes(html, 'Revolut tip');
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

test('support: popup shows the link and both addresses exactly as donate.js and donate.txt', function () {
  var env = runPopup(REAL_DONATE);
  var txt = donateTxt();
  var e = env.els;
  assert.equal(e['support'].hidden, false, 'card shown');
  assert.equal(e['support-revolut'].hidden, false, 'revolut row');
  assert.equal(e['support-btc'].hidden, false, 'btc row');
  assert.equal(e['support-usdc'].hidden, false, 'usdc row');
  assert.equal(e['support-link'].href, REAL_DONATE.url);
  assert.equal(e['btc-address'].textContent, REAL_DONATE.btc);
  assert.equal(e['usdc-address'].textContent, REAL_DONATE.usdcErc20);
  assert.equal(e['support-link'].href, txt.url);
  assert.equal(e['btc-address'].textContent, txt.btc);
  assert.equal(e['usdc-address'].textContent, txt.usdcErc20);
  return settle();
});

test('support: popup copy buttons copy the exact address and show "Copied"', function () {
  var env = runPopup(REAL_DONATE);
  var btn = env.els['btc-copy'];
  btn.fire('click');
  env.els['usdc-copy'].fire('click');
  assert.deepEqual(env.copied, [REAL_DONATE.btc, REAL_DONATE.usdcErc20]);
  assert.deepEqual(env.copied, [donateTxt().btc, donateTxt().usdcErc20]);
  return settle().then(function () {
    assert.equal(btn.textContent, 'Copied');
    assert.equal(env.els['usdc-copy'].textContent, 'Copied');
    __advanceTimers(5000);
    assert.equal(btn.textContent, 'Copy', 'label restored');
  });
});

test('support: popup copy falls back to selecting the address', function () {
  var env = runPopup(REAL_DONATE, { clipboardFails: true });
  env.els['usdc-copy'].fire('click');
  return settle().then(function () {
    assert.equal(env.selected, env.els['usdc-address'], 'address selected');
    assert.notIncludes(env.els['usdc-copy'].textContent, 'Copied');
    __advanceTimers(5000);
  });
});

test('support: popup tip link opens a new tab with the donate.js link and closes the popup', function () {
  var env = runPopup(REAL_DONATE);
  var ev = env.els['support-link'].fire('click');
  assert.ok(ev.defaultPrevented, 'default prevented');
  assert.deepEqual(env.tabsCreated, [{ url: REAL_DONATE.url }]);
  return settle().then(function () { assert.equal(env.closed, 1, 'popup closed'); });
});

test('support: popup hides rows without a value, and the card when none is set', function () {
  var env = runPopup({ url: '', usdcErc20: '', btc: REAL_DONATE.btc, btcNote: REAL_DONATE.btcNote, usdcNote: '' });
  assert.equal(env.els['support'].hidden, false, 'card shown');
  assert.equal(env.els['support-revolut'].hidden, true, 'no revolut row');
  assert.equal(env.els['support-usdc'].hidden, true, 'no usdc row');
  assert.equal(env.els['support-btc'].hidden, false, 'btc row');
  var none = runPopup({ url: '', usdcErc20: '', btc: '' });
  assert.equal(none.els['support'].hidden, true, 'card hidden');
  var missing = runPopup(undefined);
  assert.equal(missing.els['support'].hidden, true, 'card hidden without donate.js');
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

test('support: settings page copy buttons copy the exact address', function () {
  var env = runOptions(REAL_DONATE);
  env.els['btc-copy'].fire('click');
  env.els['usdc-copy'].fire('click');
  assert.deepEqual(env.copied, [REAL_DONATE.btc, REAL_DONATE.usdcErc20]);
  assert.deepEqual(env.copied, [donateTxt().btc, donateTxt().usdcErc20]);
  return settle().then(function () {
    assert.equal(env.els['btc-copied'].textContent, 'Copied.');
    __advanceTimers(5000);
  });
});

test('support: settings page hides the card when nothing is set', function () {
  var env = runOptions({ url: '', usdcErc20: '', btc: '' });
  assert.equal(env.els['support'].hidden, true);
  return settle();
});
