/*
 * Page script (MAIN world, document_start). Last file of build/main-world.js (tools/build.py),
 * after config.js, settings.js, logger.js, frame.js, m3u8.js, gql.js, processor.js,
 * worker-main.js, worker-source.js and recovery.js; declared in manifest.json.
 *
 * It:
 *  1. hooks window.fetch to capture the GQL headers (Client-ID, Device-ID, Authorization,
 *     Client-Integrity, Client-Version, Client-Session-Id) and rewrites the page's own live
 *     PlaybackAccessToken playerType (site -> popout, docs/research-technique.md §3 item 7);
 *  2. replaces window.Worker with a subclass that wraps Twitch's blob workers with our
 *     worker code (src/core/worker-source.js);
 *  3. answers token requests from workers using the page's real fetch and captured headers;
 *  4. passes worker events to the ISOLATED-world bridge (stats, toast) and to recovery.
 *
 * Settings: defaults are available synchronously (src/shared/settings.js); the bridge sends
 * the stored settings as soon as chrome.storage answers, which is long before Twitch creates
 * its worker; workers created earlier get them by message.
 *
 * Off switch (settings.enabled === false): no playerType rewrite, no Worker wrapping once the
 * stored settings have arrived (before that a worker may be wrapped, and the worker code then
 * passes every request through itself), worker token requests answered with null, recovery idle.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) return;

  // Take what we need, then remove the namespace from the page's global object.
  var cfg = ns.config;
  var M = ns.m3u8;
  var G = ns.gql;
  var S = ns.settings;
  var frame = ns.frame;
  var createLogger = ns.createLogger;
  var buildWorkerSource = ns.buildWorkerSource;
  var isWrappedWorkerSource = ns.isWrappedWorkerSource;
  var Recovery = ns.recovery;
  var parts = {
    m3u8Factory: ns.m3u8Factory,
    processorFactory: ns.processorFactory,
    loggerFactory: ns.loggerFactory,
    workerMain: ns.workerMain
  };
  try { delete root.__TAS__; } catch (e) { /* ignore */ }

  var GUARD = '__tas_page_installed__';
  if (root[GUARD]) return;
  try { Object.defineProperty(root, GUARD, { value: true, enumerable: false }); } catch (e) { return; }

  if (!frame.shouldRunInFrame(root.location.hostname, root.location.pathname, frame.isTopFrame(root))) return;

  var KEY = cfg.messageKey;
  var settings = S.defaults();
  var settingsReceived = false;
  var log = createLogger('page', function () { return !!settings.debug; });
  var captured = {};
  var fallbackDeviceId = G.randomDeviceId();
  var workers = new Set();
  var degraded = {};
  var doc = root.document;

  // ------------------------------------------------------------------ bridge messaging
  function toBridge(msg) {
    try {
      doc.dispatchEvent(new CustomEvent(cfg.events.toBridge, { detail: JSON.stringify(msg) }));
    } catch (e) { /* ignore */ }
  }

  function postToWorker(w, msg) {
    var o = {};
    o[KEY] = msg;
    try { w.postMessage(o); } catch (e) { workers.delete(w); }
  }

  function broadcast(msg) {
    workers.forEach(function (w) { postToWorker(w, msg); });
  }

  doc.addEventListener(cfg.events.toPage, function (e) {
    var msg;
    try { msg = JSON.parse(e.detail); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'settings') {
      settings = S.normalize(msg.settings);
      settingsReceived = true;
      broadcast({ type: 'settings', settings: settings });
      log.debug('settings updated');
    } else if (msg.type === 'ping') {
      hello();
    }
  });

  function isEnabled() { return settings.enabled !== false; }

  function hello() {
    toBridge({ type: 'hello', version: cfg.version, top: frame.isTopFrame(root), degraded: Object.keys(degraded) });
  }

  // ------------------------------------------------------------------ recovery
  var recovery = Recovery.createRecovery({
    cfg: cfg,
    log: log,
    doc: doc,
    win: root,
    isEnabled: isEnabled,
    emit: function (name, data) { toBridge({ type: 'event', name: name, data: data }); },
    onDegrade: function (channel) {
      degraded[channel] = true;
      broadcast({ type: 'degrade', channel: channel });
      toBridge({ type: 'event', name: 'degraded', data: { channel: channel } });
    }
  });

  // ------------------------------------------------------------------ fetch hook
  var realFetch = root.fetch;

  function requestToken(channel, playerType) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, cfg.tokenTimeoutMs);
    var body = JSON.stringify(G.buildTokenBody(cfg, channel, playerType));
    var headers = G.buildTokenHeaders(cfg, captured, fallbackDeviceId);
    return realFetch.call(root, cfg.gql.url, { method: 'POST', headers: headers, body: body, signal: ctrl.signal })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var tok = j ? G.parseTokenResponse(j) : null;
        if (!tok) log.debug('no token for', playerType);
        return tok;
      })
      .catch(function (e) {
        log.debug('token request failed for', playerType, e && e.message);
        return null;
      })
      .then(function (tok) { clearTimeout(timer); return tok; });
  }

  if (typeof realFetch === 'function') {
    root.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.indexOf(cfg.gql.url) === 0) {
          var hs = init && init.headers ? init.headers : (input && typeof input === 'object' && input.headers);
          if (hs) {
            var h = G.extractHeaders(cfg, hs);
            Object.keys(h).forEach(function (k) { captured[k] = h[k]; });
          }
          if (isEnabled() && init && typeof init.body === 'string') {
            var r = G.rewritePlayerType(init.body, cfg);
            if (r.changed) {
              init = Object.assign({}, init, { body: r.body });
              log.debug('page token request playerType ->', cfg.forcedPlayerType);
            }
          }
        }
      } catch (e) {
        log.warn('fetch hook error (request passed through)', e && e.message);
      }
      return realFetch.call(this === undefined ? root : this, input, init);
    };
  }

  // ------------------------------------------------------------------ worker hook
  function readSync(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.overrideMimeType('text/javascript');
    xhr.send();
    return xhr.status === 200 || xhr.status === 0 ? xhr.responseText : null;
  }

  function isTwitchWorkerUrl(s) {
    var u = new URL(s, root.location.href);
    var origin = u.origin && u.origin !== 'null' ? u.origin : null;
    if (!origin) return false;
    var host = new URL(origin).hostname;
    return host === 'twitch.tv' || /\.twitch\.tv$/.test(host);
  }

  function wrapWorkerUrl(scriptURL) {
    var s = String(scriptURL);
    if (!isTwitchWorkerUrl(s)) return null;
    var src = readSync(s);
    if (!src || isWrappedWorkerSource(src)) return null;
    var code = buildWorkerSource(parts, cfg, { settings: settings, degraded: Object.keys(degraded) }, src);
    var blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    setTimeout(function () { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } }, 60000);
    return blobUrl;
  }

  function onWorkerMessage(w, msg) {
    if (msg.type === 'token-request') {
      if (!isEnabled()) {
        // Switched off while the worker was busy: no extra GQL request; the worker discards
        // whatever it was processing and serves the original playlist.
        postToWorker(w, { type: 'token-response', id: msg.id, token: null });
        return;
      }
      requestToken(msg.channel, msg.playerType).then(function (tok) {
        postToWorker(w, { type: 'token-response', id: msg.id, token: tok });
      });
    } else if (msg.type === 'event') {
      log.debug('event', msg.name, msg.data);
      toBridge({ type: 'event', name: msg.name, data: msg.data });
      recovery.onEvent(msg.name, msg.data);
    }
  }

  function attach(w) {
    workers.add(w);
    w.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || !d[KEY]) return;
      e.stopImmediatePropagation();
      try { onWorkerMessage(w, d[KEY]); } catch (err) { log.warn('worker message error', err && err.message); }
    });
    var term = w.terminate;
    try {
      Object.defineProperty(w, 'terminate', {
        configurable: true,
        writable: true,
        value: function () { workers.delete(w); return term.apply(this, arguments); }
      });
    } catch (e) { /* ignore */ }
  }

  var OriginalWorker = root.Worker;
  if (typeof OriginalWorker === 'function') {
    var TasWorker = class Worker extends OriginalWorker {
      constructor(scriptURL, options) {
        var wrapped = null;
        var off = settingsReceived && settings.enabled === false;
        try { if (!off) wrapped = wrapWorkerUrl(scriptURL); } catch (e) { log.warn('worker wrap failed, using original', e && e.message); }
        if (wrapped) {
          var ok = true;
          try {
            super(wrapped, options);
          } catch (e) {
            ok = false;
            log.warn('wrapped worker rejected, using original', e && e.message);
            super(scriptURL, options);
          }
          if (ok) attach(this);
        } else {
          super(scriptURL, options);
        }
      }
    };
    try {
      Object.defineProperty(root, 'Worker', { value: TasWorker, configurable: true, writable: true, enumerable: false });
    } catch (e) {
      log.warn('could not replace Worker', e && e.message);
    }
  }

  hello();
  log.debug('page hooks installed');
})(typeof globalThis !== 'undefined' ? globalThis : this);
