/*
 * GQL helpers for the PlaybackAccessToken request. Pure (no DOM, no fetch); the page script
 * does the actual request with the page's real fetch. Source of the request shape:
 * docs/research-technique.md §1.1 (values live in src/config.js).
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] gql.js needs config.js first');

  function tasGqlFactory() {
    'use strict';

    /** Body for a backup token request (persisted query). */
    function buildTokenBody(cfg, channel, playerType, opts) {
      var isVod = !!(opts && opts.isVod);
      var platform = cfg.gql.androidPlatformPlayerTypes.indexOf(playerType) !== -1 ? 'android' : 'web';
      return {
        operationName: cfg.gql.operationName,
        variables: {
          isLive: !isVod,
          login: isVod ? '' : String(channel || ''),
          isVod: isVod,
          vodID: isVod ? String((opts && opts.vodId) || '') : '',
          playerType: playerType,
          platform: platform
        },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: cfg.gql.persistedQueryHash }
        }
      };
    }

    /** Random 32-char [a-z0-9] device id (used only when none was captured). */
    function randomDeviceId(rand) {
      var r = rand || Math.random;
      var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      var s = '';
      for (var i = 0; i < 32; i++) s += chars.charAt(Math.floor(r() * chars.length));
      return s;
    }

    /**
     * Headers for a backup token request, from headers captured off the page's own GQL calls.
     * @param captured lower-case header name -> value
     */
    function buildTokenHeaders(cfg, captured, fallbackDeviceId) {
      var c = captured || {};
      var h = {
        'Client-ID': c['client-id'] || cfg.gql.clientId,
        'Content-Type': 'text/plain; charset=UTF-8'
      };
      var device = c['device-id'] || c['x-device-id'] || fallbackDeviceId;
      if (device) { h['Device-ID'] = device; h['X-Device-Id'] = device; }
      h.Authorization = c.authorization || 'undefined';
      if (c['client-integrity']) h['Client-Integrity'] = c['client-integrity'];
      if (c['client-version']) h['Client-Version'] = c['client-version'];
      if (c['client-session-id']) h['Client-Session-Id'] = c['client-session-id'];
      return h;
    }

    /** Extract the captured header set from any fetch HeadersInit (Headers, array, object). */
    function extractHeaders(cfg, headersInit) {
      var out = {};
      if (!headersInit) return out;
      var want = cfg.gql.capturedHeaders;
      function put(k, v) {
        var key = String(k).toLowerCase();
        if (want.indexOf(key) !== -1 && v !== undefined && v !== null && v !== '') out[key] = String(v);
      }
      if (typeof headersInit.forEach === 'function' && !Array.isArray(headersInit)) {
        headersInit.forEach(function (v, k) { put(k, v); });
      } else if (Array.isArray(headersInit)) {
        headersInit.forEach(function (pair) { if (pair && pair.length >= 2) put(pair[0], pair[1]); });
      } else if (typeof headersInit === 'object') {
        Object.keys(headersInit).forEach(function (k) { put(k, headersInit[k]); });
      }
      return out;
    }

    /** { value, signature } from a GQL response (object or batched array), else null. */
    function parseTokenResponse(json) {
      var items = Array.isArray(json) ? json : [json];
      for (var i = 0; i < items.length; i++) {
        var d = items[i] && items[i].data;
        var t = d && (d.streamPlaybackAccessToken || d.videoPlaybackAccessToken);
        if (t && t.value && t.signature) return { value: t.value, signature: t.signature };
      }
      return null;
    }

    /**
     * Rewrite variables.playerType of the page's own live PlaybackAccessToken request(s).
     * Only types listed in cfg.forcedPlayerTypeFrom are rewritten. Returns { body, changed }.
     * Never throws; unparseable bodies are returned unchanged.
     */
    function rewritePlayerType(body, cfg) {
      if (!cfg.forcedPlayerType || typeof body !== 'string' || body.indexOf(cfg.gql.operationName) === -1) {
        return { body: body, changed: false };
      }
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) { return { body: body, changed: false }; }
      var list = Array.isArray(parsed) ? parsed : [parsed];
      var changed = false;
      list.forEach(function (op) {
        if (!op || op.operationName !== cfg.gql.operationName || !op.variables) return;
        var v = op.variables;
        if (v.isLive && !v.isVod && cfg.forcedPlayerTypeFrom.indexOf(v.playerType) !== -1) {
          v.playerType = cfg.forcedPlayerType;
          changed = true;
        }
      });
      return changed ? { body: JSON.stringify(parsed), changed: true } : { body: body, changed: false };
    }

    return {
      buildTokenBody: buildTokenBody,
      buildTokenHeaders: buildTokenHeaders,
      extractHeaders: extractHeaders,
      parseTokenResponse: parseTokenResponse,
      rewritePlayerType: rewritePlayerType,
      randomDeviceId: randomDeviceId
    };
  }

  ns.gqlFactory = tasGqlFactory;
  ns.gql = tasGqlFactory();
})(typeof globalThis !== 'undefined' ? globalThis : this);
