/*
 * Page script (MAIN world, document_start). Last file of build/main-world.js (tools/build.py),
 * after config.js, settings.js, logger.js, frame.js, m3u8.js, gql.js, processor.js,
 * worker-main.js, worker-source.js and health.js; declared in manifest.json.
 *
 * It:
 *  1. hooks window.fetch to capture the GQL headers (Client-ID, Device-ID, Authorization,
 *     Client-Integrity, Client-Version, Client-Session-Id) and rewrites the page's own live
 *     PlaybackAccessToken playerType (site -> popout, docs/research-technique.md §3 item 7);
 *  2. replaces window.Worker with a subclass that wraps Twitch's blob workers with our
 *     worker code (src/core/worker-source.js);
 *  3. answers token requests from workers using the page's real fetch and captured headers;
 *  4. passes worker events to the ISOLATED-world bridge (stats, toast) and to health.js
 *     (playback metrics and the one gated nudge after a playlist switch);
 *  5. with settings.blockClientAds, answers Twitch's client-side ad requests (m3u8.isClientAdUrl,
 *     GET) locally with a successful "no ad" (no fill): an empty VAST document with status 200
 *     (m3u8.noAdResponse; /ads/format gets an empty 204), on live and VOD. The request succeeds
 *     from the page's point of view, so nothing plays and nothing fails (a *failed* ad request
 *     is the likely trigger of Twitch's ad-block notice; cf. TTV-AB "ad spoofing").
 *     Also with settings.blockClientAds: a GQL request naming one of cfg.clientAdGqlOperations
 *     (FetchAdsService_FetchAds) goes out as usual, and its answer's ad VAST is replaced with the
 *     empty VAST (gql.neutraliseFetchAds); anything unexpected leaves the answer untouched.
 *
 * Settings: defaults are available synchronously (src/shared/settings.js); the bridge sends
 * the stored settings as soon as chrome.storage answers, which is long before Twitch creates
 * its worker; workers created earlier get them by message.
 *
 * Off switch (settings.enabled === false): no playerType rewrite, no Worker wrapping once the
 * stored settings have arrived (before that a worker may be wrapped, and the worker code then
 * passes every request through itself), worker token requests answered with null, health idle.
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
  var Health = ns.health;
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
    toBridge({ type: 'hello', version: cfg.version, top: frame.isTopFrame(root) });
  }

  // ------------------------------------------------------------------ playback health
  var health = Health.createHealth({
    cfg: cfg,
    log: log,
    doc: doc,
    win: root,
    isEnabled: isEnabled,
    emit: function (name, data) {
      if (name === 'health' && !settings.debug) return; // metrics are for the debug log only
      toBridge({ type: 'event', name: name, data: data });
    }
  });

  // ------------------------------------------------------------------ fetch hook
  var realFetch = root.fetch;

  var tokenHashState = { hashIndex: 0 }; // persisted query hash that last answered (gql.fetchToken)

  function requestToken(channel, playerType) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, cfg.tokenTimeoutMs);
    // The page's own captured GQL headers (Client-Integrity, Device-ID, Authorization, ...) go
    // on every try, the hash fallback included (Purple T-401).
    var headers = G.buildTokenHeaders(cfg, captured, fallbackDeviceId);
    function post(body) {
      return realFetch.call(root, cfg.gql.url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal })
        .then(function (r) { return r.ok ? r.json() : null; });
    }
    return G.fetchToken(cfg, post, channel, playerType, null, tokenHashState)
      .then(function (tok) {
        if (!tok) log.debug('no token for', playerType);
        return tok;
      })
      .catch(function (e) {
        log.debug('token request failed for', playerType, e && e.message);
        return null;
      })
      .then(function (tok) { clearTimeout(timer); return tok; });
  }

  // ------------------------------------------------------------------ client-side ads (live and VOD)
  var EMPTY_VAST_URL = 'data:application/xml,%3CVAST%20version%3D%223.0%22%3E%3C%2FVAST%3E';

  /** True when this request is a client-side ad request to answer locally. */
  function blocksClientAd(url, method) {
    if (!isEnabled() || settings.blockClientAds === false) return false;
    return String(method || 'GET').toUpperCase() === 'GET' && M.isClientAdUrl(url, cfg);
  }

  function noAdResponse(input, init) {
    var signal = init && init.signal !== undefined ? init.signal : (input && typeof input === 'object' ? input.signal : null);
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason !== undefined ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
    }
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    return Promise.resolve(M.noAdResponse(url));
  }

  /** Response headers as a plain object, without content-length / content-encoding (the body changes). */
  function copyHeaders(h) {
    var o = {};
    if (h && typeof h.forEach === 'function') {
      h.forEach(function (v, k) {
        var lk = String(k).toLowerCase();
        if (lk !== 'content-length' && lk !== 'content-encoding') o[k] = v;
      });
    }
    return o;
  }

  /**
   * GQL client-side ad answer (FetchAdsService_FetchAds, live run 2026-11-23 jynxzi): the same
   * response with every fetchAds VAST replaced by the empty VAST, status and headers kept. The
   * original response on anything unexpected (non-JSON, other shape) or when switched off.
   */
  function withoutClientAd(res) {
    if (!res || !res.ok || typeof res.clone !== 'function') return res;
    return res.clone().text().then(function (text) {
      if (!isEnabled() || settings.blockClientAds === false) return res;
      var json = JSON.parse(text);
      var r = G.neutraliseFetchAds(json, M.EMPTY_VAST);
      if (!r.changed) return res;
      var out = new Response(JSON.stringify(r.json), { status: res.status, statusText: res.statusText, headers: copyHeaders(res.headers) });
      try { if (res.url) Object.defineProperty(out, 'url', { value: res.url }); } catch (e) { /* url stays '' */ }
      log.debug('client-side ad answer (GQL fetchAds) emptied');
      return out;
    }).catch(function (e) {
      log.debug('GQL fetchAds answer left untouched', e && e.message);
      return res;
    });
  }

  var XP = root.XMLHttpRequest && root.XMLHttpRequest.prototype;
  var realXhrOpen = XP && XP.open;
  if (typeof realXhrOpen === 'function') {
    XP.open = function (method, url) {
      try {
        if (blocksClientAd(String(url), method)) {
          log.debug('client-side ad request answered locally (xhr)');
          var a = Array.prototype.slice.call(arguments);
          a[1] = EMPTY_VAST_URL;
          return realXhrOpen.apply(this, a);
        }
      } catch (e) { /* open as asked */ }
      return realXhrOpen.apply(this, arguments);
    };
  }

  if (typeof realFetch === 'function') {
    root.fetch = function (input, init) {
      var clientAdGql = false;
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
        if (blocksClientAd(url, method)) {
          log.debug('client-side ad request answered locally (fetch)');
          return noAdResponse(input, init);
        }
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
            clientAdGql = settings.blockClientAds !== false && G.isClientAdGqlRequest(init.body, cfg);
          }
        }
      } catch (e) {
        log.warn('fetch hook error (request passed through)', e && e.message);
      }
      var p = realFetch.call(this === undefined ? root : this, input, init);
      return clientAdGql ? p.then(withoutClientAd) : p;
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
    var code = buildWorkerSource(parts, cfg, { settings: settings }, src);
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
      health.onEvent(msg.name, msg.data);
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
