/*
 * Minimal browser stand-ins for jsc (which has no DOM, URL, Blob, Worker, fetch, console).
 * installBrowserStubs(opts) puts them on globalThis and returns an env object that records
 * what the code under test did. Only what page.js / bridge.js / cosmetic.js touch is stubbed.
 *
 * opts.chrome: true installs a fake chrome.* (runtime, storage) with env.stored as storage.
 */
function installBrowserStubs(opts) {
  opts = opts || {};
  var g = globalThis;
  var env = {
    docListeners: {}, dispatched: [], fetches: [], workers: [], blobs: {}, xhrUrls: [],
    workerSource: 'self.twitchWorker = 1;', sentToBackground: [], stored: opts.stored || {},
    created: [], logs: [], blobCount: 0
  };

  g.console = {
    log: function () { env.logs.push(['log'].concat([].slice.call(arguments))); },
    debug: function () {}, info: function () {},
    warn: function () { env.logs.push(['warn'].concat([].slice.call(arguments))); },
    error: function () { env.logs.push(['error'].concat([].slice.call(arguments))); }
  };

  function parseUrl(s) {
    var m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(s);
    return m ? { protocol: m[1], host: m[2], pathname: m[3] || '/', search: m[4] || '' } : null;
  }
  function FakeURL(s, base) {
    s = String(s);
    if (s.indexOf('blob:') === 0) {
      var inner = parseUrl(s.slice(5));
      this.href = s;
      this.origin = inner ? inner.protocol + '//' + inner.host : 'null';
      this.hostname = '';
      return;
    }
    var p = parseUrl(s);
    if (!p && base) {
      var b = parseUrl(String(base));
      if (!b) throw new TypeError('bad base');
      p = { protocol: b.protocol, host: b.host, pathname: s.charAt(0) === '/' ? s : '/' + s, search: '' };
    }
    if (!p) throw new TypeError('Invalid URL: ' + s);
    this.protocol = p.protocol;
    this.hostname = p.host.replace(/:\d+$/, '').toLowerCase();
    this.origin = p.protocol + '//' + p.host;
    this.pathname = p.pathname;
    this.search = p.search;
    this.href = this.origin + p.pathname + p.search;
  }
  FakeURL.createObjectURL = function (blob) {
    var u = 'blob:https://www.twitch.tv/tas-' + (++env.blobCount);
    env.blobs[u] = blob;
    return u;
  };
  FakeURL.revokeObjectURL = function () {};
  g.URL = FakeURL;
  g.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; this.text = parts.join(''); };
  g.AbortController = function () { this.signal = { aborted: false }; this.abort = function () { this.signal.aborted = true; }; };
  g.CustomEvent = function (type, init) { this.type = type; this.detail = init ? init.detail : undefined; };
  g.MutationObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };

  function el(tag) {
    var e = {
      nodeName: String(tag).toUpperCase(), nodeType: 1, children: [], parentNode: null, attrs: {},
      textContent: '',
      style: {
        props: {}, prio: {},
        setProperty: function (k, v, p) { this.props[k] = v; this.prio[k] = p || ''; },
        removeProperty: function (k) { delete this.props[k]; delete this.prio[k]; },
        getPropertyValue: function (k) { return this.props[k] || ''; },
        getPropertyPriority: function (k) { return this.prio[k] || ''; }
      },
      setAttribute: function (k, v) { this.attrs[k] = String(v); },
      getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild: function (c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; },
      getElementsByTagName: function () { return []; }
    };
    return e;
  }

  env.el = el;

  var doc = {
    documentElement: el('html'), head: el('head'), body: el('body'),
    addEventListener: function (type, fn) { (env.docListeners[type] = env.docListeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      env.docListeners[type] = (env.docListeners[type] || []).filter(function (f) { return f !== fn; });
    },
    dispatchEvent: function (ev) {
      env.dispatched.push(ev);
      (env.docListeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
      return true;
    },
    createElement: function (tag) { var e = el(tag); env.created.push(e); return e; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementsByTagName: function () { return []; }
  };
  g.document = doc;
  g.location = { hostname: 'www.twitch.tv', pathname: '/somechannel', href: 'https://www.twitch.tv/somechannel' };
  g.top = g;

  g.fetch = function (input, init) {
    env.fetches.push({ input: input, init: init });
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };

  g.XMLHttpRequest = function () {
    var self = this;
    this.open = function (m, u) { self.url = u; env.xhrUrls.push(u); };
    this.overrideMimeType = function () {};
    this.send = function () { self.status = 200; self.responseText = env.workerSource; };
  };

  g.Worker = class Worker {
    constructor(url, o) {
      this.scriptURL = url;
      this.options = o;
      this.posted = [];
      this.listeners = [];
      env.workers.push(this);
    }
    postMessage(m) { this.posted.push(m); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    terminate() { this.terminated = true; }
  };
  env.OriginalWorker = g.Worker;

  if (opts.chrome) {
    var storageListeners = [];
    g.chrome = {
      runtime: {
        id: 'test-extension-id',
        sendMessage: function (m) { env.sentToBackground.push(m); return Promise.resolve(); },
        onMessage: { addListener: function (fn) { env.runtimeListener = fn; } }
      },
      storage: {
        local: { get: function (k) { var o = {}; o[k] = env.stored[k]; return Promise.resolve(o); } },
        onChanged: { addListener: function (fn) { storageListeners.push(fn); } }
      }
    };
    env.changeStorage = function (key, value) {
      var ch = {};
      ch[key] = { newValue: value, oldValue: env.stored[key] };
      env.stored[key] = value;
      storageListeners.forEach(function (fn) { fn(ch, 'local'); });
    };
  }

  /** Send a message to the page script as the bridge would. */
  env.toPage = function (cfg, msg) {
    doc.dispatchEvent(new g.CustomEvent(cfg.events.toPage, { detail: JSON.stringify(msg) }));
  };
  /** Send a message to the bridge as the page script would. */
  env.toBridge = function (cfg, msg) {
    doc.dispatchEvent(new g.CustomEvent(cfg.events.toBridge, { detail: JSON.stringify(msg) }));
  };
  /** Messages of a given direction that went over the document event bus. */
  env.messages = function (type) {
    return env.dispatched.filter(function (e) { return e.type === type; }).map(function (e) { return JSON.parse(e.detail); });
  };
  return env;
}
