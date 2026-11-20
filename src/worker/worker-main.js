/*
 * Code that runs INSIDE Twitch's video worker. It is never loaded as a file in the worker:
 * the page script serialises tasWorkerMain with Function.prototype.toString into a new blob
 * (see src/core/worker-source.js), together with the config, m3u8, processor and logger
 * factories. So tasWorkerMain must not reference anything outside its own body; everything
 * comes in through its parameters.
 *
 * It replaces the worker's fetch:
 *   - ad segment URLs we have seen  -> tiny valid blank response, no network request
 *   - usher master playlists        -> parsed, variants remembered (processor.onMaster)
 *   - known media playlists         -> processor.onMedia (backup / strip)
 *   - anything else                 -> original fetch, untouched
 * Any internal exception returns the original response untouched.
 * settings.enabled === false (sent by the page when the user switches the extension off):
 * every request goes to the original fetch untouched, and a playlist that was already being
 * processed when the switch flipped is answered with the original response.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] worker-main.js needs config.js first');

  function tasWorkerMain(scope, cfg, boot, M, createProcessor, createLogger) {
    'use strict';
    var KEY = cfg.messageKey;
    var settings = boot.settings || {};
    var log = createLogger('worker', function () { return !!settings.debug; });
    var realFetch = scope.fetch.bind(scope);
    var pending = new Map();
    var nextId = 1;

    function post(msg) {
      var o = {};
      o[KEY] = msg;
      try { scope.postMessage(o); } catch (e) { /* worker closing */ }
    }

    function decode(b64) {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    var blankTs = decode(cfg.blankTsBase64);
    var blankMp4 = decode(cfg.blankMp4Base64);

    function blankResponse(url) {
      var isTs = /\.ts$/i.test(M.splitUrl(url).base);
      return new Response(isTs ? blankTs : blankMp4, {
        status: 200,
        headers: { 'Content-Type': isTs ? 'video/mp2t' : 'video/mp4' }
      });
    }

    function getToken(channel, playerType) {
      return new Promise(function (resolve) {
        var id = nextId++;
        var timer = setTimeout(function () {
          if (pending.has(id)) { pending.delete(id); resolve(null); }
        }, cfg.tokenTimeoutMs + 1000);
        pending.set(id, function (tok) { clearTimeout(timer); resolve(tok); });
        post({ type: 'token-request', id: id, channel: channel, playerType: playerType });
      });
    }

    function fetchText(url) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.fetchTimeoutMs) : null;
      return realFetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (res) {
        return res.text().then(function (text) { return { status: res.status, text: text }; });
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        return r;
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw e;
      });
    }

    var proc = createProcessor({
      cfg: cfg,
      m3u8: M,
      getSettings: function () { return settings; },
      fetchText: fetchText,
      getToken: getToken,
      now: function () { return Date.now(); },
      emit: function (name, data) {
        log.debug('event', name, data);
        post({ type: 'event', name: name, data: data || {} });
      },
      log: log
    });

    scope.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || !d[KEY]) return;
      // Ours: keep it away from Twitch's own message handlers.
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      var msg = d[KEY];
      try {
        if (msg.type === 'token-response') {
          var cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg.token || null); }
        } else if (msg.type === 'settings') {
          settings = msg.settings || settings;
        }
      } catch (err) {
        log.warn('message handling failed', err && err.message);
      }
    });

    function off() { return settings.enabled === false; }

    function rebuild(text, res) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    function handleMaster(input, init, url, u) {
      var req = input;
      if (u.kind === 'live' && cfg.forcedPlayerType && typeof input === 'string') {
        req = M.removeQueryParams(input, cfg.usherDropParams);
      }
      return realFetch(req, init).then(function (res) {
        if (!res || res.status !== 200 || off()) return res;
        return res.clone().text().then(function (text) {
          if (off()) return res;
          var out = proc.onMaster(typeof req === 'string' ? req : url, text);
          return out === text ? res : rebuild(out, res);
        }).catch(function (e) {
          log.warn('master hook failed, passing through', e && e.message);
          return res;
        });
      });
    }

    function handleMedia(input, init, url) {
      return realFetch(input, init).then(function (res) {
        if (!res || res.status !== 200 || off()) return res;
        return res.clone().text().then(function (text) {
          if (off()) return res;
          return proc.onMedia(url, text).then(function (out) {
            // Switched off while backups were being fetched: serve what Twitch sent.
            return out === text || off() ? res : rebuild(out, res);
          });
        }).catch(function (e) {
          log.warn('media hook failed, passing through', e && e.message);
          post({ type: 'event', name: 'failure', data: { where: 'worker-media', message: String(e && e.message) } });
          return res;
        });
      });
    }

    scope.fetch = function (input, init) {
      var url;
      try {
        // Switched off in the popup while this tab was open: stay passive until the reload.
        if (off()) return realFetch(input, init);
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (proc.isAdSegment(url)) return Promise.resolve(blankResponse(url));
        var u = M.matchUsher(url, cfg);
        if (u) return handleMaster(input, init, url, u);
        if (M.isM3u8Url(url) && proc.knowsMedia(url)) return handleMedia(input, init, url);
      } catch (e) {
        log.warn('fetch hook failed, passing through', e && e.message);
      }
      return realFetch(input, init);
    };

    log.debug('worker hooks installed');
    return { processor: proc };
  }

  ns.workerMain = tasWorkerMain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
