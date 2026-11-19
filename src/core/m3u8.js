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
     *    after a middle gap is only right within this one playlist: live playlists the player
     *    sees go through resequence(), which keeps numbers stable across polls.
     *  - fMP4 (#EXT-X-MAP): MAP lines are not copied where they stand. A kept segment gets the MAP
     *    in force for it written first (after its DISCONTINUITY) when that differs from the last
     *    MAP written or a DISCONTINUITY precedes it. A MAP first used by a removed (ad) segment is
     *    the ad's init segment: it is never written, and a kept segment after it with no MAP of
     *    its own keeps the previous kept segment's MAP (the ad's must never apply to live video).
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
      // curMap: last MAP read; claimed: a segment came after it; forAd: first used by a removed
      // segment; keptMap: MAP of the last kept segment; outMap: last MAP written to out.
      var curMap = null, mapClaimed = true, mapForAd = false, keptMap = null, outMap = null;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        if (line.charAt(0) === '#') {
          if (line.indexOf(cfg.prefetchTag) === 0) {
            if (adContext) { prefetchRemoved++; continue; }
            var pm = mapClaimed && mapForAd ? keptMap : curMap;
            if (pm && pm !== outMap) { out.push(pm); outMap = pm; }
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
          if (line.indexOf('#EXT-X-MAP:') === 0) { curMap = line; mapClaimed = false; continue; }
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
          if (!mapClaimed) mapForAd = true;
          mapClaimed = true;
        } else {
          if (kept === 0) { leadingRemoved = removed; leadingDisc = droppedDisc; }
          if (gap && !hasDisc) pending.unshift('#EXT-X-DISCONTINUITY');
          if (!mapClaimed) mapForAd = false;
          mapClaimed = true;
          var map = mapForAd ? keptMap : curMap;
          keptMap = map;
          var di = pending.indexOf('#EXT-X-DISCONTINUITY');
          if (map && (map !== outMap || di !== -1)) { pending.splice(di + 1, 0, map); outMap = map; }
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

    function parseIntTag(line) {
      var n = parseInt(tagValue(line), 10);
      return isNaN(n) ? null : n;
    }

    /**
     * Parse a media playlist into { header, segs, tail, tailMap, mediaSeq, discSeq, liveSeq,
     * targetDuration, endlist }. header: tags before the first segment, without the numbering
     * tags, TARGETDURATION and EXT-X-MAP. segs: { url, tags (without DISCONTINUITY and MAP), disc,
     * map, pdt (ms|null), dur (s), live (live number|null) }. tail: tags after the last URI
     * (prefetch etc.).
     * map: the #EXT-X-MAP line in force for the segment (fMP4 init segment; a MAP applies to every
     * following segment until the next one, RFC 8216 §4.3.2.5), null for MPEG-TS. tailMap: a MAP
     * after the last URI that differs from the last segment's (it belongs to the tail's prefetch).
     * Live numbers: #EXT-X-TWITCH-LIVE-SEQUENCE is the number of the first LIVE segment. When
     * some #EXTINF titles carry cfg.liveSegmentTitle ("live"), only those segments are numbered:
     * the first live-titled one gets the header's number, the following live-titled ones count
     * up until a DISCONTINUITY between them or a segment that is not live (stitched preroll:
     * ad segments first, then the live ones; the ads get null). Titled segments but none live
     * (ad-only preroll poll that already carries the header): nothing is numbered. With no titles
     * at all, the first segment gets the number and the following ones count up until the first
     * DISCONTINUITY after it. Past that, unknown (null).
     * cfg is optional (only liveSegmentTitle is read; default "live").
     */
    function parseMedia(text, cfg) {
      var liveTitle = (cfg && cfg.liveSegmentTitle) || 'live';
      var lines = splitLines(text || '');
      var r = { header: [], segs: [], tail: [], tailMap: null, mediaSeq: 0, discSeq: 0, liveSeq: null, targetDuration: 0, endlist: false };
      var pending = [];
      var started = false;
      var map = null;
      var liveTitled = [], anyLiveTitle = false, anyOtherTitle = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        if (line.charAt(0) === '#') {
          if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) { r.mediaSeq = parseIntTag(line) || 0; continue; }
          if (line.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE:') === 0) { r.discSeq = parseIntTag(line) || 0; continue; }
          if (line.indexOf('#EXT-X-TWITCH-LIVE-SEQUENCE:') === 0) { r.liveSeq = parseIntTag(line); continue; }
          if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) { r.targetDuration = parseFloat(tagValue(line)) || 0; continue; }
          if (line.indexOf('#EXT-X-ENDLIST') === 0) { r.endlist = true; continue; }
          if (line.indexOf('#EXT-X-MAP:') === 0) { map = line; continue; }
          if (isSegmentTag(line)) { started = true; pending.push(line); continue; }
          if (!started) r.header.push(line); else pending.push(line);
          continue;
        }
        var seg = { url: line, tags: [], disc: false, map: map, pdt: null, dur: 0, live: null };
        var isLive = false;
        for (var p = 0; p < pending.length; p++) {
          var t = pending[p];
          if (t === '#EXT-X-DISCONTINUITY') { seg.disc = true; continue; }
          if (t.indexOf('#EXTINF') === 0) {
            seg.dur = parseFloat(tagValue(t)) || 0;
            var title = extinfTitle(t);
            isLive = title.indexOf(liveTitle) !== -1;
            if (!isLive && title) anyOtherTitle = true;
          }
          if (t.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) {
            var ms = Date.parse(tagValue(t));
            if (!isNaN(ms)) seg.pdt = ms;
          }
          seg.tags.push(t);
        }
        r.segs.push(seg);
        liveTitled.push(isLive);
        if (isLive) anyLiveTitle = true;
        pending = [];
        started = true;
      }
      for (var q = 0; q < pending.length; q++) {
        if (pending[q].indexOf('#EXTINF') !== 0 && pending[q] !== '#EXT-X-DISCONTINUITY') r.tail.push(pending[q]);
      }
      if (map !== null && (!r.segs.length || r.segs[r.segs.length - 1].map !== map)) r.tailMap = map;
      if (r.liveSeq !== null && anyLiveTitle) {
        var n = 0;
        for (var k = 0; k < r.segs.length; k++) {
          if (!liveTitled[k]) { if (n > 0) break; continue; }
          if (n > 0 && r.segs[k].disc) break;
          r.segs[k].live = r.liveSeq + n++;
        }
      } else if (r.liveSeq !== null && !anyOtherTitle) {
        for (var k2 = 0; k2 < r.segs.length; k2++) {
          if (k2 > 0 && r.segs[k2].disc) break;
          r.segs[k2].live = r.liveSeq + k2;
        }
      }
      return r;
    }

    /** Per player-facing playlist state for resequence(). */
    function newSequenceState() {
      return {
        active: false, win: [], seen: new Map(), next: 0, baseDn: 0,
        lastEnd: null, lastLive: null, lastSource: null, passthrough: null
      };
    }

    function segKey(s) { return s.live !== null && s.live !== undefined ? 'L' + s.live : 'U' + s.url; }

    /**
     * Give the player a continuous, stable view of a live media playlist across polls and
     * sources (native, stripped native, backup). docs/research-2026-11-13.md C1/C3.
     *  - A segment keeps the number it was first given. It is identified by its live number
     *    where known (same live segment = same identity in native and backup playlists), else by
     *    URL. A segment whose live number is not past the newest one given, or (no live numbers)
     *    which ends before what was given, is a segment the player already has: it is not listed
     *    again under a new number.
     *  - New segments get the next number, so MEDIA-SEQUENCE never jumps or goes back.
     *  - #EXT-X-DISCONTINUITY before the first new segment after a source change, a live-number
     *    gap, a date-time gap, an init segment (EXT-X-MAP) change, or where the source had one;
     *    DISCONTINUITY-SEQUENCE counts the ones that slid out, so it is monotonic too.
     *  - fMP4: each window entry keeps the MAP it was given under (parseMedia seg.map). The output
     *    never takes MAP from the header: the entry's MAP is written before the first listed
     *    segment, after every DISCONTINUITY and wherever it changes, so a segment is never decoded
     *    with another source's init segment (picture lost, audio plays).
     *  - The output lists the newest max(source segments, minSegments) segments given (so an
     *    all-stripped poll repeats the newest known ones instead of an empty playlist).
     * state.passthrough: the last playlist served untouched before the first rewrite; its
     * numbering seeds the state.
     * Returns { text, appended, repeat } (repeat: an appended segment overlaps what was given).
     */
    function resequence(st, text, sourceKey, opts) {
      var o = opts || {};
      var maxWindow = o.maxWindow || 30, minSegments = o.minSegments || 3, maxSeen = o.maxSeen || 400;
      var overlapTol = o.overlapToleranceMs === undefined ? 250 : o.overlapToleranceMs;
      var gapTol = o.gapToleranceMs === undefined ? 1500 : o.gapToleranceMs;
      var repeatTol = o.repeatToleranceMs === undefined ? 500 : o.repeatToleranceMs;
      var p = parseMedia(text);

      function remember(s, seq, dn, src) {
        var e = { seq: seq, url: s.url, tags: s.tags, map: s.map || null, dn: dn, dur: s.dur, live: s.live, pdt: s.pdt };
        st.win.push(e);
        st.seen.set(segKey(s), seq);
        st.seen.set('U' + s.url, seq);
        st.lastLive = s.live !== null && s.live !== undefined ? s.live : null;
        if (s.pdt !== null) st.lastEnd = s.pdt + s.dur * 1000;
        else if (st.lastEnd !== null) st.lastEnd += s.dur * 1000;
        st.lastSource = src;
      }

      if (!st.active) {
        st.active = true;
        var seed = st.passthrough ? parseMedia(st.passthrough) : null;
        st.passthrough = null;
        if (seed && seed.segs.length) {
          var dn0 = seed.discSeq;
          for (var a = 0; a < seed.segs.length; a++) {
            if (a > 0 && (seed.segs[a].disc || (seed.segs[a].map || null) !== (seed.segs[a - 1].map || null))) dn0++;
            remember(seed.segs[a], seed.mediaSeq + a, dn0, 'native');
          }
          st.next = seed.mediaSeq + seed.segs.length;
        } else {
          st.next = p.mediaSeq;
          st.baseDn = p.discSeq;
        }
      }
      var segs = p.segs;
      var appended = 0, repeat = false;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (st.seen.has(segKey(s)) || st.seen.has('U' + s.url)) continue;
        var hasLive = s.live !== null && st.lastLive !== null;
        if (hasLive) {
          if (s.live <= st.lastLive) continue; // the player already has this live segment
        } else if (s.pdt !== null && st.lastEnd !== null && s.pdt + s.dur * 1000 <= st.lastEnd + overlapTol) {
          continue;
        }
        if (!hasLive && s.pdt !== null && st.lastEnd !== null && st.lastEnd - s.pdt > repeatTol) repeat = true;
        var last = st.win.length ? st.win[st.win.length - 1] : null;
        var disc = !!last && (s.disc || sourceKey !== st.lastSource || last.map !== (s.map || null) ||
          (hasLive && s.live > st.lastLive + 1) ||
          (s.pdt !== null && st.lastEnd !== null && s.pdt - st.lastEnd > gapTol));
        var dn = last ? last.dn + (disc ? 1 : 0) : st.baseDn;
        remember(s, st.next++, dn, sourceKey);
        appended++;
      }
      while (st.win.length > maxWindow) st.win.shift();
      while (st.seen.size > maxSeen) st.seen.delete(st.seen.keys().next().value);

      var out = st.win.slice(-Math.max(segs.length, minSegments));
      var header = p.header;
      var lines = [];
      var td = p.targetDuration;
      for (var d = 0; d < out.length; d++) td = Math.max(td, Math.ceil(out[d].dur));
      var rest = header.filter(function (l) { return l.indexOf('#EXTM3U') !== 0; });
      var vi = -1;
      for (var h = 0; h < rest.length; h++) if (rest[h].indexOf('#EXT-X-VERSION') === 0) { vi = h; break; }
      lines.push('#EXTM3U');
      var numbering = ['#EXT-X-TARGETDURATION:' + (td || 6)];
      numbering.push('#EXT-X-MEDIA-SEQUENCE:' + (out.length ? out[0].seq : st.next));
      numbering.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + (out.length ? out[0].dn : st.baseDn));
      // Twitch's meaning: the number of the first live segment listed (parseMedia).
      var liveSeq = p.liveSeq;
      for (var lv = 0; lv < out.length; lv++) {
        if (out[lv].live !== null && out[lv].live !== undefined) { liveSeq = out[lv].live; break; }
      }
      if (liveSeq !== null && liveSeq !== undefined) numbering.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + liveSeq);
      rest.splice(vi + 1, 0, numbering.join('\n'));
      lines.push(rest.join('\n'));
      var curMap = null;
      for (var j = 0; j < out.length; j++) {
        var discHere = j > 0 && out[j].dn !== out[j - 1].dn;
        if (discHere) lines.push('#EXT-X-DISCONTINUITY');
        if (out[j].map && (j === 0 || discHere || out[j].map !== curMap)) { lines.push(out[j].map); curMap = out[j].map; }
        for (var t = 0; t < out[j].tags.length; t++) lines.push(out[j].tags[t]);
        lines.push(out[j].url);
      }
      // Prefetch hints belong to the source's newest segment: only when that is our newest too.
      if (segs.length && out.length && out[out.length - 1].url === segs[segs.length - 1].url) {
        if (p.tailMap && p.tail.length && p.tailMap !== curMap) lines.push(p.tailMap);
        for (var q = 0; q < p.tail.length; q++) lines.push(p.tail[q]);
      }
      return { text: lines.filter(function (l) { return l !== ''; }).join('\n') + '\n', appended: appended, repeat: repeat };
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
     * Pick the backup variant for the variant the player chose (docs/DESIGN-v2.md "Never lower
     * quality"): the same RESOLUTION (width and height; audio-only matches audio-only) and the
     * same codec family, else null, so a backup never lowers the quality or switches the decoder
     * to another codec. Among those: equal FRAME-RATE, then the same CODECS string (profile/level
     * and audio codec: no decoder reconfiguration), then the higher bandwidth.
     * A target without CODECS (family unknown) accepts any family.
     */
    function pickVariant(variants, target, cfg) {
      if (!variants || !variants.length || !target) return null;
      var tw = target.width || 0, th = target.height || 0;
      var tFam = codecFamily(target.codecs, cfg);
      var cands = variants.filter(function (v) {
        return !!v.url && (v.width || 0) === tw && (v.height || 0) === th &&
          (tFam === 'unknown' || codecFamily(v.codecs, cfg) === tFam);
      });
      var tFps = target.frameRate || 0;
      function score(v) {
        var fps = Math.abs((v.frameRate || 0) - tFps);
        var codecs = target.codecs && v.codecs === target.codecs ? 0 : 1;
        return [fps, codecs, -(v.bandwidth || 0)];
      }
      var best = null, bestScore = null;
      for (var i = 0; i < cands.length; i++) {
        var s = score(cands[i]);
        if (!best || compare(s, bestScore) < 0) { best = cands[i]; bestScore = s; }
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
      parseMedia: parseMedia,
      newSequenceState: newSequenceState,
      resequence: resequence,
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
