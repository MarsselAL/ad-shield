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
 *  media playlist   -> no ads: serve it; after nativeSwitchBackPolls clean polls end the break.
 *                   -> ads:    try backup playerTypes in order (pinned type first); for each, get a
 *                              token, fetch the backup master, take the variant of the same
 *                              resolution and codec family as the player's (none: skip the type
 *                              for this poll), fetch its media playlist; the first ad-free one is
 *                              served (and its type pinned). docs/DESIGN-v2.md "Twitch".
 *                              No clean backup (or the poll deadline passed): the native playlist
 *                              with ad segments and prefetch removed, renumbered continuously
 *                              (m3u8.resequence, DISCONTINUITY at the boundaries). The type the
 *                              page's own token was rewritten to (cfg.forcedPlayerType) is never
 *                              tried. Stripping would leave no segment (or, before anything was
 *                              served, fewer than sequencer.minSegments): no poll deadline, the
 *                              search runs to its end, and with no clean backup the original
 *                              playlist is served unmodified ('ad-passthrough'), never an empty one.
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
     *   now(): number, emit(name, data), log?, setTimeout?, clearTimeout?
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
            lockouts: {}, backupMasters: {}, flags: {}
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
        // The page's own token is already this type (gql.rewritePlayerType): its playlist is the
        // native one, ads included, so asking for it again cannot help.
        var order = settings().playerTypes.filter(function (t) { return !cfg.forcedPlayerType || t !== cfg.forcedPlayerType; });
        if (c.pinned) {
          var i = order.indexOf(c.pinned);
          if (i > 0) { order.splice(i, 1); order.unshift(c.pinned); }
        }
        return order;
      }

      var setT = deps.setTimeout || (typeof setTimeout === 'function' ? function (f, ms) { return setTimeout(f, ms); } : null);
      var clearT = deps.clearTimeout || (typeof clearTimeout === 'function' ? function (id) { clearTimeout(id); } : function () {});
      var views = new Map();      // player-facing media playlist URL -> m3u8 sequence state

      function viewFor(url) {
        var v = views.get(url);
        if (!v) {
          v = M.newSequenceState();
          views.set(url, v);
          bound(views, cfg.maxTrackedPlaylists);
        }
        return v;
      }

      function tryBackups(c, target) {
        var order = backupOrder(c);
        var tries = 0;
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
          // The type being served keeps its master past the TTL, so a steady-state backup poll is
          // one fetch (a failing media fetch drops it below).
          if (cached && (now() - cached.at < cfg.backupMasterTtlMs || c.serving === 'backup:' + type)) {
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
            // Same resolution and codec family as the player's variant, or this type is skipped
            // for this poll (no lockout: the player may pick a resolution it has next poll).
            var v = M.pickVariant(entry.variants, target, cfg);
            if (!v) { log.debug('backup', type, 'has no', target.resolution || 'audio', 'variant'); return null; }
            return deps.fetchText(v.url).then(function (res) {
              if (!res || res.status !== 200) { delete c.backupMasters[type]; lock(c, type); return null; }
              if (M.hasAds(res.text, cfg)) {
                // This type has its own ad: new token next time, skip it for a moment.
                delete c.backupMasters[type];
                lock(c, type);
                log.debug('backup', type, 'also has ads');
                return null;
              }
              c.pinned = type;
              return { type: type, text: res.text, variant: v };
            });
          });
        }
        return next();
      }

      /** One backup search per channel at a time; later polls join the one in flight. */
      function search(c, target) {
        if (c.search) return c.search.target === target.url ? c.search.promise : Promise.resolve(null);
        var entry = { target: target.url, promise: null };
        function done(r) { if (c.search === entry) c.search = null; return r || null; }
        entry.promise = Promise.resolve().then(function () { return tryBackups(c, target); }).then(done, function (e) {
          log.debug('backup search failed', e && e.message);
          return done(null);
        });
        c.search = entry;
        return entry.promise;
      }

      /** Resolve with p's value, or null after cfg.backupPollDeadlineMs (p keeps running). */
      function withDeadline(p) {
        var ms = cfg.backupPollDeadlineMs;
        if (!(ms > 0) || !setT) return p;
        return new Promise(function (resolve) {
          var settled = false;
          var id = setT(function () {
            if (settled) return;
            settled = true;
            log.debug('backup search over the poll deadline: serving stripped, search continues');
            resolve(null);
          }, ms);
          function finish(r) {
            if (settled) return;
            settled = true;
            resolve(r);
            try { clearT(id); } catch (e) { /* the answer is already out */ }
          }
          p.then(finish, function () { finish(null); });
        });
      }

      function endBreak(c) {
        emit('ad-end', {
          channel: c.id, midroll: c.midroll,
          outcome: c.flags.backup ? 'backup' : (c.flags.stripped ? 'stripped' : 'none')
        });
        c.inBreak = false;
        c.flags = {};
      }

      function isBackup(serving) { return String(serving).indexOf('backup:') === 0; }

      function canSwap(c) {
        return c.kind === 'live' && !!c.masterUrl && settings().playerTypes.length > 0;
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
          var ch = c;
          var planP = plan(ch, info, text, ads).then(null, function (e) {
            log.warn('backup search failed, stripping', e && e.message);
            if (!ads) return { kind: 'native' };
            var st = M.stripAds(text, cfg);
            return { kind: st.removed > 0 && st.kept < 1 ? 'original' : 'stripped', stripped: st };
          });
          // Answers leave in request order, so an older slow answer never overtakes a newer
          // one, and state changes (switch events, numbering) happen in that order too.
          var prev = ch.tail || Promise.resolve();
          var out = Promise.all([prev, planP]).then(function (r) {
            return finalize(ch, url, text, r[1]);
          }).then(null, function (e) {
            log.warn('media finalize failed, passing through', e && e.message);
            emit('failure', { channel: ch.id, where: 'media', message: String(e && e.message) });
            return text;
          });
          ch.tail = out.then(function () {}, function () {});
          return out;
        } catch (e) {
          log.warn('media processing failed, passing through', e && e.message);
          emit('failure', { channel: c && c.id, where: 'media', message: String(e && e.message) });
          return Promise.resolve(text);
        }
      }

      /** Decide what to serve (may wait for the backup search, bounded by the poll deadline). */
      function plan(c, info, text, ads) {
        if (!ads) {
          c.cleanStreak = (c.cleanStreak || 0) + 1;
          if (isBackup(c.serving) && c.cleanStreak < cfg.nativeSwitchBackPolls && canSwap(c)) {
            // Native looks clean again: stay on the backup for one more poll (debounce).
            return withDeadline(search(c, info.variant)).then(function (b) {
              return b ? { kind: 'backup', b: b } : { kind: 'native' };
            });
          }
          return Promise.resolve({ kind: 'native' });
        }
        c.cleanStreak = 0;
        if (!c.inBreak) {
          c.inBreak = true;
          c.midroll = M.isMidroll(text, cfg);
          c.flags = {};
          emit('ad-detected', { channel: c.id, midroll: c.midroll, classes: M.classifyDateranges(text, cfg).ad });
        }
        var stripped = M.stripAds(text, cfg);
        // Too thin to serve stripped: nothing left, or (nothing served yet for this channel) fewer
        // than the sequencer's minimum, so a fresh player would give up. No poll deadline then:
        // wait for the whole search (each step has its own timeouts); still nothing clean ->
        // the original playlist, ad included (an ad that plays beats a dead player).
        var thin = stripped.removed > 0 && (stripped.kept < 1 ||
          (c.kind === 'live' && !c.served && stripped.kept < cfg.sequencer.minSegments));
        if (!thin) rememberAdSegments(stripped.removedUrls);
        var fallback = thin ? { kind: 'original', stripped: stripped } : { kind: 'stripped', stripped: stripped };
        if (!canSwap(c)) return Promise.resolve(fallback);
        var found = search(c, info.variant);
        return (thin ? found : withDeadline(found)).then(function (b) {
          return b ? { kind: 'backup', b: b } : fallback;
        });
      }

      function sequenced(c, url, original, served, sourceKey) {
        if (c.kind !== 'live' || !M.isLivePlaylist(served)) return served;
        var view = viewFor(url);
        if (!view.active && served === original && sourceKey === 'native') {
          view.passthrough = original; // untouched: the player keeps Twitch's own numbering
          return original;
        }
        var r = M.resequence(view, served, sourceKey, cfg.sequencer);
        if (r.repeat) {
          var t = now();
          if (!c.lastRepeatAt || t - c.lastRepeatAt >= cfg.repeatEventMinIntervalMs) {
            c.lastRepeatAt = t;
            emit('segment-repeat', { channel: c.id });
          }
        }
        return r.text;
      }

      /** Apply a plan (in request order) and build the answer. */
      function finalize(c, url, original, pl) {
        c.served = true;
        if (pl.kind === 'original') return serveOriginal(c, url, original, pl.stripped);
        if (pl.kind === 'native') {
          if (c.inBreak) endBreak(c);
          setServing(c, 'native');
          return sequenced(c, url, original, original, 'native');
        }
        if (pl.kind === 'backup') {
          var b = pl.b;
          if (c.inBreak && !c.flags.backup) {
            c.flags.backup = true;
            emit('ad-blocked-backup', { channel: c.id, midroll: c.midroll, playerType: b.type, resolution: b.variant.resolution });
          }
          setServing(c, 'backup:' + b.type);
          var key = 'backup:' + b.type + ':' + (b.variant.resolution || 'audio') + ':' + (b.variant.frameRate || 0) + ':' + (b.variant.codecs || '');
          return sequenced(c, url, original, b.text, key);
        }
        // Stripped native: ad segments removed; resequence keeps the numbering continuous (an
        // all-ad poll lists the newest segments the player already has, under their numbers).
        return sequenced(c, url, original, serveStripped(c, original, pl.stripped), 'native');
      }

      /** Stripping would leave too little and no backup is clean: the native playlist as is. */
      function serveOriginal(c, url, original, stripped) {
        // The player must be able to load the ad segments (the worker blanks remembered ones).
        for (var i = 0; i < stripped.removedUrls.length; i++) adSegments.delete(stripped.removedUrls[i]);
        if (!c.flags.passthrough) {
          c.flags.passthrough = true;
          emit('ad-passthrough', { channel: c.id, midroll: c.midroll, kept: stripped.kept, removed: stripped.removed });
        }
        setServing(c, 'native');
        return sequenced(c, url, original, original, 'native');
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
            emit('ad-stripped', { channel: c.id, midroll: c.midroll, removed: stripped.removed });
          }
          setServing(c, 'stripped');
          return stripped.text;
        } catch (e) {
          emit('failure', { channel: c.id, where: 'strip', message: String(e && e.message) });
          return original;
        }
      }

      function stateOf(channel) {
        var c = channels.get('live:' + String(channel).toLowerCase());
        return c ? { pinned: c.pinned, inBreak: c.inBreak, serving: c.serving, lockouts: c.lockouts } : null;
      }

      return {
        onMaster: onMaster,
        onMedia: onMedia,
        knowsMedia: knowsMedia,
        isAdSegment: isAdSegment,
        stateOf: stateOf
      };
    };
  }

  ns.processorFactory = tasProcessorFactory;
  ns.createProcessor = tasProcessorFactory();
})(typeof globalThis !== 'undefined' ? globalThis : this);
