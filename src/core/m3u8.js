/*
 * Core HLS (m3u8) functions. Pure: no DOM, no chrome.*, no URL/Response globals.
 *
 * tasM3u8Factory is self-contained (no outer-scope references) so the page script can inline
 * it into the video worker blob with Function.prototype.toString. Every function takes the
 * config object (src/config.js) as an argument instead of reading a global.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] m3u8.js needs config.js first');

  function tasM3u8Factory() {
    'use strict';

    function splitLines(text) {
      return String(text).split(/\r?\n/);
    }

    /** Parse an HLS attribute list: KEY=VALUE,KEY="quoted, value",... */
    function parseAttributes(str) {
      var out = {};
      var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
      var m;
      while ((m = re.exec(str)) !== null) {
        var v = m[2];
        if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
        out[m[1]] = v;
      }
      return out;
    }

    function tagValue(line) {
      var i = line.indexOf(':');
      return i === -1 ? '' : line.slice(i + 1);
    }

    function daterangeClass(line) {
      var m = /(?:^|[:,])CLASS="([^"]*)"/.exec(line);
      return m ? m[1] : '';
    }

    function isIgnoredDaterange(line, cfg) {
      if (line.indexOf('#EXT-X-DATERANGE') !== 0) return false;
      var cls = daterangeClass(line);
      return !!cls && cfg.ignoredDaterangeClasses.indexOf(cls) !== -1;
    }

    function isAdDaterange(line, cfg) {
      if (line.indexOf('#EXT-X-DATERANGE') !== 0) return false;
      var cls = daterangeClass(line);
      if (cls && cfg.ignoredDaterangeClasses.indexOf(cls) !== -1) return false;
      if (cls && cfg.adDaterangeClasses.indexOf(cls) !== -1) return true;
      for (var i = 0; i < cfg.adMarkers.length; i++) {
        if (line.indexOf(cfg.adMarkers[i]) !== -1) return true;
      }
      return false;
    }

    /** True if the media playlist contains any ad marker (ignored DATERANGE classes excluded). */
    function hasAds(text, cfg) {
      if (!text) return false;
      var s = String(text);
      // Fast path: no marker and no ad DATERANGE class anywhere.
      var any = false;
      for (var i = 0; i < cfg.adMarkers.length && !any; i++) {
        if (s.indexOf(cfg.adMarkers[i]) !== -1) any = true;
      }
      for (var c = 0; c < cfg.adDaterangeClasses.length && !any; c++) {
        if (s.indexOf('"' + cfg.adDaterangeClasses[c] + '"') !== -1) any = true;
      }
      if (!any) return false;
      var lines = splitLines(s);
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (line.indexOf('#EXT-X-DATERANGE') === 0) {
          if (isIgnoredDaterange(line, cfg)) continue;
          if (isAdDaterange(line, cfg)) return true;
          continue;
        }
        for (var k = 0; k < cfg.adMarkers.length; k++) {
          if (line.indexOf(cfg.adMarkers[k]) !== -1) return true;
        }
      }
      return false;
    }

    function isMidroll(text, cfg) {
      if (!text) return false;
      for (var i = 0; i < cfg.midrollMarkers.length; i++) {
        if (String(text).indexOf(cfg.midrollMarkers[i]) !== -1) return true;
      }
      return false;
    }

    /** List DATERANGE classes found, split into ad / ignored / unknown (for diagnostics). */
    function classifyDateranges(text, cfg) {
      var res = { ad: [], ignored: [], unknown: [] };
      splitLines(text || '').forEach(function (line) {
        if (line.indexOf('#EXT-X-DATERANGE') !== 0) return;
        var cls = daterangeClass(line);
        var bucket;
        if (cls && cfg.ignoredDaterangeClasses.indexOf(cls) !== -1) bucket = res.ignored;
        else if (isAdDaterange(line, cfg)) bucket = res.ad;
        else bucket = res.unknown;
        var name = cls || '(no class)';
        if (bucket.indexOf(name) === -1) bucket.push(name);
      });
      return res;
    }

    function isAdSegmentUrl(url, cfg) {
      if (!url) return false;
      for (var i = 0; i < cfg.adSegmentUrlPatterns.length; i++) {
        if (String(url).indexOf(cfg.adSegmentUrlPatterns[i]) !== -1) return true;
      }
      return false;
    }

    function isLivePlaylist(text) {
      return String(text).indexOf('#EXT-X-ENDLIST') === -1;
    }

    function extinfTitle(line) {
      var v = tagValue(line);
      var c = v.indexOf(',');
      return c === -1 ? '' : v.slice(c + 1);
    }

    function isAdSegment(extinfLine, url, inCue, live, cfg) {
      if (inCue) return true;
      if (isAdSegmentUrl(url, cfg)) return true;
      var title = extinfLine ? extinfTitle(extinfLine) : '';
      for (var i = 0; i < cfg.adSegmentTitlePrefixes.length; i++) {
        if (title.indexOf(cfg.adSegmentTitlePrefixes[i]) === 0) return true;
      }
      // In a live playlist, real content segments are titled "live".
      if (live && extinfLine && title.indexOf(cfg.liveSegmentTitle) === -1) return true;
      return false;
    }

    var SEGMENT_TAGS = ['#EXTINF', '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-BYTERANGE', '#EXT-X-GAP', '#EXT-X-BITRATE'];
    function isSegmentTag(line) {
      if (line === '#EXT-X-DISCONTINUITY') return true;
      for (var i = 0; i < SEGMENT_TAGS.length; i++) {
        if (line.indexOf(SEGMENT_TAGS[i]) === 0) return true;
      }
      return false;
    }

    function neutralizeAdUrls(line, cfg) {
      try {
        return line.replace(new RegExp(cfg.adUrlAttributePattern, 'g'), '$1https://twitch.tv$2');
      } catch (e) {
        return line;
      }
    }

    /**
     * Remove ad segments, ad DATERANGE/CUE tags and (in an ad context) prefetch / LL-HLS part
     * tags from a media playlist.
     * Returns { text, removed, kept, removedUrls, prefetchRemoved }.
     *  - All non-ad segments are kept, in order, with their own tags.
     *  - #EXT-X-MEDIA-SEQUENCE is raised by the number of leading removed segments, so the first
     *    kept segment keeps its true sequence number.
     *  - #EXT-X-DISCONTINUITY-SEQUENCE is raised by the discontinuities dropped with leading
     *    removed segments; a single #EXT-X-DISCONTINUITY is put before a kept segment that
     *    follows removed ones (timestamps jump there). HLS cannot express gaps, so numbering
     *    after a middle gap is best-effort.
     */
    function stripAds(text, cfg) {
      var src = String(text || '');
      var adContext = hasAds(src, cfg);
      var live = isLivePlaylist(src);
      var lines = splitLines(src);
      var endsWithNewline = /\n$/.test(src);
      if (endsWithNewline) lines.pop();

      var out = [];
      var pending = [];
      var extinf = null;
      var inCue = false;
      var removed = 0, kept = 0, prefetchRemoved = 0;
      var removedUrls = [];
      var droppedDisc = 0, leadingRemoved = 0, leadingDisc = 0;
      var gap = false;
      var seqIdx = -1, discSeqIdx = -1;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        if (line.charAt(0) === '#') {
          if (line.indexOf(cfg.prefetchTag) === 0) {
            if (adContext) { prefetchRemoved++; continue; }
            out.push(line); continue;
          }
          if (adContext && (line.indexOf('#EXT-X-PART:') === 0 || line.indexOf('#EXT-X-PRELOAD-HINT') === 0)) continue;
          if (line.indexOf('#EXT-X-CUE-OUT') === 0) { inCue = true; continue; }
          if (line.indexOf('#EXT-X-CUE-IN') === 0) { inCue = false; continue; }
          if (line.indexOf('#EXT-X-DATERANGE') === 0) {
            if (isAdDaterange(line, cfg)) continue;
            out.push(neutralizeAdUrls(line, cfg));
            continue;
          }
          if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) { seqIdx = out.length; out.push(line); continue; }
          if (line.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE:') === 0) { discSeqIdx = out.length; out.push(line); continue; }
          if (isSegmentTag(line)) {
            if (line.indexOf('#EXTINF') === 0) extinf = line;
            pending.push(line);
            continue;
          }
          if (pending.length) pending.push(line); else out.push(line);
          continue;
        }
        // URI line: completes a segment.
        var hasDisc = pending.indexOf('#EXT-X-DISCONTINUITY') !== -1;
        if (isAdSegment(extinf, line, inCue, live, cfg)) {
          removed++;
          removedUrls.push(line);
          if (hasDisc) droppedDisc++;
          if (kept > 0) gap = true;
        } else {
          if (kept === 0) { leadingRemoved = removed; leadingDisc = droppedDisc; }
          if (gap && !hasDisc) pending.unshift('#EXT-X-DISCONTINUITY');
          for (var p = 0; p < pending.length; p++) out.push(pending[p]);
          out.push(line);
          kept++;
          gap = false;
        }
        pending = [];
        extinf = null;
      }
      // Tags after the last URI (e.g. an EXTINF without URI yet): keep non-segment ones.
      for (var q = 0; q < pending.length; q++) {
        if (pending[q].indexOf('#EXTINF') !== 0) out.push(pending[q]);
      }
      if (kept === 0) { leadingRemoved = removed; leadingDisc = droppedDisc; }

      if (removed > 0) {
        if (seqIdx !== -1) {
          var seq = parseInt(tagValue(out[seqIdx]), 10);
          if (!isNaN(seq)) out[seqIdx] = '#EXT-X-MEDIA-SEQUENCE:' + (seq + leadingRemoved);
        }
        if (leadingDisc > 0) {
          if (discSeqIdx !== -1) {
            var dseq = parseInt(tagValue(out[discSeqIdx]), 10);
            if (!isNaN(dseq)) out[discSeqIdx] = '#EXT-X-DISCONTINUITY-SEQUENCE:' + (dseq + leadingDisc);
          } else {
            var at = seqIdx !== -1 ? seqIdx + 1 : Math.min(1, out.length);
            out.splice(at, 0, '#EXT-X-DISCONTINUITY-SEQUENCE:' + leadingDisc);
          }
        }
      }

      return {
        text: out.join('\n') + (endsWithNewline ? '\n' : ''),
        removed: removed,
        kept: kept,
        removedUrls: removedUrls,
        prefetchRemoved: prefetchRemoved
      };
    }

    /** Count media segments (URI lines) in a media playlist. */
    function countSegments(text) {
      var n = 0;
      splitLines(text || '').forEach(function (l) { if (l && l.charAt(0) !== '#') n++; });
      return n;
    }

    function codecFamily(codecs, cfg) {
      var c = String(codecs || '').toLowerCase();
      function has(list) {
        for (var i = 0; i < list.length; i++) if (c.indexOf(list[i]) !== -1) return true;
        return false;
      }
      if (!c) return 'unknown';
      if (has(cfg.hevcCodecPrefixes)) return 'hevc';
      if (has(cfg.av1CodecPrefixes)) return 'av1';
      if (has(cfg.avcCodecPrefixes)) return 'avc';
      return 'other';
    }

    /** Parse a master playlist into variants. */
    function parseMaster(text) {
      var lines = splitLines(text || '');
      var media = {};
      var variants = [];
      var serverTime = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('#EXT-X-MEDIA:') === 0) {
          var ma = parseAttributes(tagValue(line));
          if (ma['GROUP-ID']) media[ma['GROUP-ID']] = ma.NAME || ma['GROUP-ID'];
        } else if (line.indexOf('#EXT-X-TWITCH-INFO:') === 0) {
          var ti = parseAttributes(tagValue(line));
          if (ti['SERVER-TIME']) serverTime = ti['SERVER-TIME'];
        } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
          var a = parseAttributes(tagValue(line));
          var url = null;
          for (var j = i + 1; j < lines.length; j++) {
            var l2 = lines[j].trim();
            if (!l2) continue;
            if (l2.charAt(0) === '#') break;
            url = l2; i = j; break;
          }
          var w = 0, h = 0;
          if (a.RESOLUTION) {
            var r = /^(\d+)x(\d+)$/.exec(a.RESOLUTION);
            if (r) { w = parseInt(r[1], 10); h = parseInt(r[2], 10); }
          }
          variants.push({
            url: url,
            bandwidth: a.BANDWIDTH ? parseInt(a.BANDWIDTH, 10) : 0,
            resolution: a.RESOLUTION || null,
            width: w,
            height: h,
            frameRate: a['FRAME-RATE'] ? parseFloat(a['FRAME-RATE']) : 0,
            codecs: a.CODECS || '',
            group: a.VIDEO || null,
            name: (a.VIDEO && media[a.VIDEO]) || a.VIDEO || null
          });
        }
      }
      variants.serverTime = serverTime;
      return variants;
    }

    /**
     * Pick the backup variant that best matches the current one.
     * Exact RESOLUTION (preferring equal FRAME-RATE), else closest pixel area; audio-only
     * targets match audio-only variants. With preferAvc, AVC variants are preferred when any exist.
     */
    function pickVariant(variants, target, cfg, opts) {
      if (!variants || !variants.length || !target) return null;
      var preferAvc = !!(opts && opts.preferAvc);
      var cands = variants.filter(function (v) { return !!v.url; });
      if (preferAvc) {
        var avc = cands.filter(function (v) { return codecFamily(v.codecs, cfg) === 'avc'; });
        if (avc.length) cands = avc;
      }
      if (!cands.length) return null;
      if (!target.width) {
        var audio = cands.filter(function (v) { return !v.width; });
        return audio.length ? audio[0] : null;
      }
      var video = cands.filter(function (v) { return v.width > 0; });
      if (!video.length) return null;
      var tFps = target.frameRate || 0;
      var tFam = codecFamily(target.codecs, cfg);
      var tArea = target.width * target.height;
      function score(v) {
        var exact = v.width === target.width && v.height === target.height ? 0 : 1;
        var area = Math.abs(v.width * v.height - tArea);
        var fps = Math.abs((v.frameRate || 0) - tFps);
        var fam = codecFamily(v.codecs, cfg) === tFam ? 0 : 1;
        return [exact, exact ? area : 0, fps, fam, -(v.bandwidth || 0)];
      }
      var best = null, bestScore = null;
      for (var i = 0; i < video.length; i++) {
        var s = score(video[i]);
        if (!best || compare(s, bestScore) < 0) { best = video[i]; bestScore = s; }
      }
      return best;
    }

    function compare(a, b) {
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return 0;
    }

    /**
     * Drop HEVC/AV1 variants from a master playlist when at least one AVC variant exists, so the
     * player never sits on a codec it cannot switch away from during an ad
     * (research-technique.md §4.3, error #4000). Returns { text, removed }.
     */
    function filterMasterCodecs(text, cfg) {
      var lines = splitLines(text || '');
      var variants = parseMaster(text);
      var hasAvc = variants.some(function (v) { return codecFamily(v.codecs, cfg) === 'avc'; });
      var hasOther = variants.some(function (v) {
        var f = codecFamily(v.codecs, cfg);
        return f === 'hevc' || f === 'av1';
      });
      if (!hasAvc || !hasOther) return { text: text, removed: 0 };
      // Rendition groups only used by removed variants are removed too.
      var keepGroups = {}, dropGroups = {};
      variants.forEach(function (v) {
        if (!v.group) return;
        var f = codecFamily(v.codecs, cfg);
        if (f === 'hevc' || f === 'av1') dropGroups[v.group] = true; else keepGroups[v.group] = true;
      });
      var out = [];
      var removed = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('#EXT-X-MEDIA:') === 0) {
          var g = parseAttributes(tagValue(line))['GROUP-ID'];
          if (g && dropGroups[g] && !keepGroups[g]) continue;
        }
        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
          var a = parseAttributes(tagValue(line));
          var f = codecFamily(a.CODECS, cfg);
          if (f === 'hevc' || f === 'av1') {
            removed++;
            // skip the URI line that follows
            for (var j = i + 1; j < lines.length; j++) {
              if (lines[j].trim() && lines[j].charAt(0) !== '#') { i = j; break; }
              if (lines[j].charAt(0) === '#') { i = j - 1; break; }
            }
            continue;
          }
        }
        out.push(line);
      }
      return { text: out.join('\n'), removed: removed };
    }

    /** Split "a?b#c" into parts without the URL global (not available in every runtime). */
    function splitUrl(url) {
      var s = String(url);
      var hash = '';
      var h = s.indexOf('#');
      if (h !== -1) { hash = s.slice(h); s = s.slice(0, h); }
      var q = s.indexOf('?');
      return { base: q === -1 ? s : s.slice(0, q), query: q === -1 ? '' : s.slice(q + 1), hash: hash };
    }

    /**
     * Build the usher URL for a backup token: keep every original query parameter except
     * sig/token and dropParams, then set the new sig and token.
     */
    function buildUsherUrl(original, token, sig, dropParams) {
      var parts = splitUrl(original);
      var drop = ['sig', 'token'].concat(dropParams || []);
      var kept = parts.query ? parts.query.split('&').filter(function (kv) {
        if (!kv) return false;
        var k = kv.split('=')[0];
        try { k = decodeURIComponent(k); } catch (e) { /* keep raw */ }
        return drop.indexOf(k) === -1;
      }) : [];
      kept.push('sig=' + encodeURIComponent(sig));
      kept.push('token=' + encodeURIComponent(token));
      return parts.base + '?' + kept.join('&') + parts.hash;
    }

    /** Remove query parameters from a URL. */
    function removeQueryParams(url, names) {
      var parts = splitUrl(url);
      if (!parts.query) return url;
      var kept = parts.query.split('&').filter(function (kv) {
        var k = kv.split('=')[0];
        return kv && names.indexOf(k) === -1;
      });
      return parts.base + (kept.length ? '?' + kept.join('&') : '') + parts.hash;
    }

    /** Classify a usher URL: { kind: 'live'|'vod', id } or null. */
    function matchUsher(url, cfg) {
      var s = String(url || '');
      for (var i = 0; i < cfg.usherIgnoreSubstrings.length; i++) {
        if (s.indexOf(cfg.usherIgnoreSubstrings[i]) !== -1) return null;
      }
      var m = new RegExp(cfg.usherLivePattern).exec(s);
      if (m) return { kind: 'live', id: decodeURIComponent(m[1]).toLowerCase() };
      m = new RegExp(cfg.usherVodPattern).exec(s);
      if (m) return { kind: 'vod', id: decodeURIComponent(m[1]) };
      return null;
    }

    function isM3u8Url(url) {
      return /\.m3u8$/i.test(splitUrl(url).base);
    }

    return {
      parseAttributes: parseAttributes,
      hasAds: hasAds,
      isMidroll: isMidroll,
      classifyDateranges: classifyDateranges,
      isAdSegmentUrl: isAdSegmentUrl,
      isLivePlaylist: isLivePlaylist,
      stripAds: stripAds,
      countSegments: countSegments,
      codecFamily: codecFamily,
      parseMaster: parseMaster,
      pickVariant: pickVariant,
      filterMasterCodecs: filterMasterCodecs,
      buildUsherUrl: buildUsherUrl,
      removeQueryParams: removeQueryParams,
      matchUsher: matchUsher,
      isM3u8Url: isM3u8Url,
      splitUrl: splitUrl
    };
  }

  ns.m3u8Factory = tasM3u8Factory;
  ns.m3u8 = tasM3u8Factory();
})(typeof globalThis !== 'undefined' ? globalThis : this);
