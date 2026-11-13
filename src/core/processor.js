/*
 * Playlist processor: the backup-stream / strip state machine that runs inside the video worker.
 *
 * Pure with injected dependencies (fetchText, getToken, now, emit), so the jsc tests drive it
 * with a fake fetch. tasProcessorFactory has no outer-scope references so it can be inlined
 * into the worker blob with Function.prototype.toString.
 *
 * Algorithm (docs/research-technique.md §4.2/§4.4):
 *  master playlist  -> remember variants (RESOLUTION, FRAME-RATE, CODECS) per media URL;
 *                      with preferAvc drop HEVC/AV1 variants when AVC exists.
 *  media playlist   -> no ads: serve it, remember it as "last clean", end any ad break.
 *                   -> ads:    try backup playerTypes in order (pinned type first); for each, get a
 *                              token, fetch the backup master, pick the matching variant, fetch its
 *                              media playlist; first ad-free one is served (and its type pinned).
 *                              If all have ads: strip ad segments + prefetch; if nothing is left,
 *                              serve the last clean playlist while it is fresh.
 *  any exception    -> the original playlist text is returned untouched.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] processor.js needs config.js first');

  function tasProcessorFactory() {
    'use strict';

    /**
     * @param deps {
     *   cfg, m3u8,                      config and the m3u8 module
     *   getSettings(): settings,        current user settings (playerTypes, preferAvc)
     *   fetchText(url): Promise<{status, text}>,
     *   getToken(channel, playerType): Promise<{value, signature}|null>,
     *   now(): number, emit(name, data), log?, degraded?: string[]
     * }
     */
    return function createProcessor(deps) {
      var cfg = deps.cfg;
      var M = deps.m3u8;
      var now = deps.now || function () { return Date.now(); };
      var emit = deps.emit || function () {};
      var log = deps.log || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
      var media = new Map();      // media playlist URL -> { key, variant }
      var channels = new Map();   // "live:<login>" / "vod:<id>" -> channel state
      var adSegments = new Map(); // ad segment URL -> time seen
      var degraded = {};
      (deps.degraded || []).forEach(function (c) { degraded[String(c).toLowerCase()] = true; });

      function settings() {
        var s = deps.getSettings ? deps.getSettings() : null;
        return s || { playerTypes: cfg.backupPlayerTypes, preferAvc: true };
      }

      function bound(map, max) {
        while (map.size > max) map.delete(map.keys().next().value);
      }

      function channelState(key, kind, id) {
        var c = channels.get(key);
        if (!c) {
          c = {
            key: key, kind: kind, id: id, masterUrl: null,
            pinned: null, inBreak: false, midroll: false, serving: 'native',
            lockouts: {}, backupMasters: {}, lastClean: null, lastCleanAt: 0,
            flags: {}
          };
          channels.set(key, c);
          bound(channels, 50);
        }
        return c;
      }

      function setServing(c, to) {
        if (c.serving === to) return;
        var from = c.serving;
        c.serving = to;
        emit('playlist-switch', { channel: c.id, from: from, to: to });
      }

      function rememberAdSegments(urls) {
        var t = now();
        for (var i = 0; i < urls.length; i++) adSegments.set(urls[i], t);
        if (adSegments.size > 500 || urls.length) {
          adSegments.forEach(function (seen, u) {
            if (t - seen > cfg.adSegmentCacheTtlMs) adSegments.delete(u);
          });
          bound(adSegments, 1000);
        }
      }

      /** Called with the master playlist text; returns the text to give the player. */
      function onMaster(url, text) {
        try {
          var u = M.matchUsher(url, cfg);
          if (!u) return text;
          var key = u.kind + ':' + u.id;
          var c = channelState(key, u.kind, u.id);
          c.masterUrl = url;
          var out = text;
          if (settings().preferAvc) {
            var f = M.filterMasterCodecs(text, cfg);
            if (f.removed > 0) {
              out = f.text;
              log.debug('removed', f.removed, 'HEVC/AV1 variants for', u.id);
            }
          }
          var variants = M.parseMaster(out);
          for (var i = 0; i < variants.length; i++) {
            if (variants[i].url) media.set(variants[i].url, { key: key, variant: variants[i] });
          }
          bound(media, cfg.maxTrackedPlaylists);
          return out;
        } catch (e) {
          log.warn('master processing failed, passing through', e && e.message);
          emit('failure', { where: 'master', message: String(e && e.message) });
          return text;
        }
      }

      function knowsMedia(url) {
        return media.has(url);
      }

      function isAdSegment(url) {
        if (!adSegments.has(url)) return false;
        if (now() - adSegments.get(url) > cfg.adSegmentCacheTtlMs) { adSegments.delete(url); return false; }
        return true;
      }

      function lock(c, type) {
        c.lockouts[type] = now() + cfg.playerTypeLockoutMs;
      }

      function backupOrder(c) {
        var order = settings().playerTypes.slice();
        if (c.pinned) {
          var i = order.indexOf(c.pinned);
          if (i > 0) { order.splice(i, 1); order.unshift(c.pinned); }
        }
        return order;
      }

      function tryBackups(c, target) {
        var order = backupOrder(c);
        var tries = 0;
        var s = settings();
        var idx = 0;
        function next() {
          if (idx >= order.length || tries >= cfg.maxBackupTypesPerPoll) return Promise.resolve(null);
          var type = order[idx++];
          if ((c.lockouts[type] || 0) > now()) return next();
          tries++;
          return attempt(type).then(function (res) { return res || next(); }, function (e) {
            log.debug('backup', type, 'error', e && e.message);
            lock(c, type);
            return next();
          });
        }
        function attempt(type) {
          var cached = c.backupMasters[type];
          var masterP;
          if (cached && now() - cached.at < cfg.backupMasterTtlMs) {
            masterP = Promise.resolve(cached);
          } else {
            masterP = Promise.resolve(deps.getToken(c.id, type)).then(function (tok) {
              if (!tok || !tok.value || !tok.signature) return null;
              var usher = M.buildUsherUrl(c.masterUrl, tok.value, tok.signature, cfg.forcedPlayerType ? cfg.usherDropParams : []);
              return deps.fetchText(usher).then(function (res) {
                if (!res || res.status !== 200) return null;
                var variants = M.parseMaster(res.text);
                if (!variants.length) return null;
                var entry = { variants: variants, at: now() };
                c.backupMasters[type] = entry;
                return entry;
              });
            });
          }
          return masterP.then(function (entry) {
            if (!entry) { lock(c, type); return null; }
            var v = M.pickVariant(entry.variants, target, cfg, { preferAvc: s.preferAvc });
            if (!v) { delete c.backupMasters[type]; lock(c, type); return null; }
            return deps.fetchText(v.url).then(function (res) {
              if (!res || res.status !== 200) { delete c.backupMasters[type]; lock(c, type); return null; }
              if (M.hasAds(res.text, cfg)) {
                // This type has its own ad: new token next time, skip it for a moment.
                delete c.backupMasters[type];
                lock(c, type);
                log.debug('backup', type, 'also has ads');
                return null;
              }
              if (cfg.neverPinPlayerTypes.indexOf(type) === -1) c.pinned = type;
              return { type: type, text: res.text, variant: v };
            });
          });
        }
        return next();
      }

      function endBreak(c) {
        emit('ad-end', { channel: c.id, midroll: c.midroll, outcome: c.flags.backup ? 'backup' : (c.flags.stripped ? 'stripped' : 'none') });
        c.inBreak = false;
        c.flags = {};
      }

      /** Called with a media playlist; resolves to the text to give the player. Never rejects. */
      function onMedia(url, text) {
        var c = null;
        try {
          var info = media.get(url);
          var ads = M.hasAds(text, cfg);
          if (!info) {
            if (!ads) return Promise.resolve(text);
            var r0 = M.stripAds(text, cfg);
            rememberAdSegments(r0.removedUrls);
            return Promise.resolve(r0.kept > 0 ? r0.text : text);
          }
          c = channels.get(info.key);
          if (!c) return Promise.resolve(text);
          if (!ads) {
            if (c.inBreak) endBreak(c);
            setServing(c, 'native');
            c.lastClean = text;
            c.lastCleanAt = now();
            return Promise.resolve(text);
          }
          if (!c.inBreak) {
            c.inBreak = true;
            c.midroll = M.isMidroll(text, cfg);
            c.flags = {};
            emit('ad-detected', { channel: c.id, midroll: c.midroll, classes: M.classifyDateranges(text, cfg).ad });
          }
          var stripped = M.stripAds(text, cfg);
          rememberAdSegments(stripped.removedUrls);
          var canSwap = c.kind === 'live' && !degraded[c.id] && c.masterUrl && settings().playerTypes.length > 0;
          var backupP = canSwap ? tryBackups(c, info.variant) : Promise.resolve(null);
          return backupP.then(function (b) {
            if (b) {
              if (!c.flags.backup) {
                c.flags.backup = true;
                emit('ad-blocked-backup', { channel: c.id, midroll: c.midroll, playerType: b.type, resolution: b.variant.resolution });
              }
              setServing(c, 'backup:' + b.type);
              return b.text;
            }
            return serveStripped(c, text, stripped);
          }).catch(function (e) {
            log.warn('backup search failed, stripping', e && e.message);
            return serveStripped(c, text, stripped);
          });
        } catch (e) {
          log.warn('media processing failed, passing through', e && e.message);
          emit('failure', { channel: c && c.id, where: 'media', message: String(e && e.message) });
          return Promise.resolve(text);
        }
      }

      function serveStripped(c, original, stripped) {
        try {
          if (stripped.removed === 0) {
            if (!c.flags.unremovable) {
              c.flags.unremovable = true;
              // Markers but no ad segments: client-side inserted ad (twitch-maf-ad) or unknown format.
              emit('ad-unremovable', { channel: c.id, midroll: c.midroll, classes: M.classifyDateranges(original, cfg).ad });
            }
            setServing(c, 'stripped');
            return stripped.text;
          }
          if (!c.flags.stripped) {
            c.flags.stripped = true;
            emit('ad-stripped', { channel: c.id, midroll: c.midroll, removed: stripped.removed, degraded: !!degraded[c.id] });
          }
          setServing(c, 'stripped');
          if (stripped.kept === 0 && c.lastClean && now() - c.lastCleanAt < cfg.lastCleanMaxAgeMs) {
            return c.lastClean;
          }
          return stripped.text;
        } catch (e) {
          emit('failure', { channel: c.id, where: 'strip', message: String(e && e.message) });
          return original;
        }
      }

      function setDegraded(channel) {
        degraded[String(channel).toLowerCase()] = true;
      }

      function stateOf(channel) {
        var c = channels.get('live:' + String(channel).toLowerCase());
        return c ? { pinned: c.pinned, inBreak: c.inBreak, serving: c.serving, lockouts: c.lockouts, degraded: !!degraded[c.id] } : null;
      }

      return {
        onMaster: onMaster,
        onMedia: onMedia,
        knowsMedia: knowsMedia,
        isAdSegment: isAdSegment,
        setDegraded: setDegraded,
        stateOf: stateOf
      };
    };
  }

  ns.processorFactory = tasProcessorFactory;
  ns.createProcessor = tasProcessorFactory();
})(typeof globalThis !== 'undefined' ? globalThis : this);
