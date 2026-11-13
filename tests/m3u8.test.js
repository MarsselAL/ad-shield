/* Core m3u8 functions against synthetic fixtures. */
loadSrc('src/config.js', 'src/core/m3u8.js');
var cfg = __TAS__.config;
var M = __TAS__.m3u8;

function segUrls(text) {
  return text.split('\n').filter(function (l) { return l && l[0] !== '#'; });
}
function tagLines(text, prefix) {
  return text.split('\n').filter(function (l) { return l.indexOf(prefix) === 0; });
}

// ------------------------------------------------------------------ detection
test('hasAds: clean playlist is not an ad', function () {
  assert.notOk(M.hasAds(fixture('clean.m3u8'), cfg));
});
test('hasAds: preroll stitched ad detected', function () {
  assert.ok(M.hasAds(fixture('preroll.m3u8'), cfg));
});
test('hasAds: midroll detected', function () {
  assert.ok(M.hasAds(fixture('midroll.m3u8'), cfg));
});
test('hasAds: only ignored DATERANGE classes (incl. one whose ID mentions stitched-ad) is NOT an ad', function () {
  assert.notOk(M.hasAds(fixture('ignored-only.m3u8'), cfg));
});
test('hasAds: twitch-maf-ad detected even when CLASS is not the first attribute', function () {
  assert.ok(M.hasAds(fixture('maf-ad.m3u8'), cfg));
});
test('hasAds: CUE-OUT marker detected', function () {
  assert.ok(M.hasAds('#EXTM3U\n#EXT-X-CUE-OUT:30\n#EXTINF:2.000,live\nseg.ts\n', cfg));
});
test('hasAds: empty / null input', function () {
  assert.notOk(M.hasAds('', cfg));
  assert.notOk(M.hasAds(null, cfg));
});
test('isMidroll: midroll vs preroll', function () {
  assert.ok(M.isMidroll(fixture('midroll.m3u8'), cfg));
  assert.notOk(M.isMidroll(fixture('preroll.m3u8'), cfg));
});
test('classifyDateranges splits ad / ignored / unknown classes', function () {
  var c = M.classifyDateranges(fixture('preroll.m3u8'), cfg);
  assert.deepEqual(c.ad, ['twitch-stitched-ad']);
  assert.ok(c.ignored.indexOf('twitch-session') !== -1);
  assert.ok(c.ignored.indexOf('twitch-ad-quartile') !== -1);
  var clean = M.classifyDateranges(fixture('clean.m3u8'), cfg);
  assert.deepEqual(clean.ad, []);
  assert.deepEqual(clean.unknown, []);
  assert.ok(clean.ignored.indexOf('timestamp') !== -1);
});
// Regression (live probe 2026-11-11): every live playlist carries a twitch-trigger DATERANGE
// even with no ad segments; it must not count as an ad.
test('twitch-trigger DATERANGE alone is not an ad', function () {
  var trig = '#EXT-X-DATERANGE:ID="trigger-1",CLASS="twitch-trigger",START-DATE="2026-11-11T21:55:25.255Z",END-ON-NEXT=YES,X-TV-TWITCH-TRIGGER-URL="https://x.invalid/trigger/abc"';
  var text = fixture('clean.m3u8').replace('#EXTINF', trig + '\n#EXTINF');
  assert.notOk(M.hasAds(text, cfg));
});
test('isAdSegmentUrl patterns', function () {
  assert.ok(M.isAdSegmentUrl('https://x.invalid/adsquared/a.ts', cfg));
  assert.ok(M.isAdSegmentUrl('https://x.invalid/_404/a.ts', cfg));
  assert.notOk(M.isAdSegmentUrl('https://video-edge.invalid/v1/segment/live.ts', cfg));
});

// ------------------------------------------------------------------ stripping
test('stripAds preroll: all live segments kept in order, ad segments and prefetch removed', function () {
  var src = fixture('preroll.m3u8');
  var r = M.stripAds(src, cfg);
  assert.equal(r.removed, 4);
  assert.equal(r.kept, 2);
  assert.deepEqual(segUrls(r.text), [
    'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-104.ts',
    'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-105.ts'
  ]);
  assert.equal(r.prefetchRemoved, 2);
  assert.notIncludes(r.text, '#EXT-X-TWITCH-PREFETCH');
  assert.notIncludes(r.text, ',Amazon|');
  assert.notIncludes(r.text, 'CLASS="twitch-stitched-ad"');
  assert.notOk(M.hasAds(r.text, cfg), 'stripped text must not be detected as ad');
  assert.equal(r.removedUrls.length, 4);
});
test('stripAds preroll: MEDIA-SEQUENCE advanced by leading removed segments', function () {
  var r = M.stripAds(fixture('preroll.m3u8'), cfg);
  assert.deepEqual(tagLines(r.text, '#EXT-X-MEDIA-SEQUENCE'), ['#EXT-X-MEDIA-SEQUENCE:104']);
  // the live segment after the ad keeps its own DISCONTINUITY (only one)
  assert.equal(tagLines(r.text, '#EXT-X-DISCONTINUITY').filter(function (l) { return l === '#EXT-X-DISCONTINUITY'; }).length, 1);
});
test('stripAds keeps non-ad DATERANGE lines but neutralises ad URL attributes', function () {
  var r = M.stripAds(fixture('preroll.m3u8'), cfg);
  assert.includes(r.text, 'CLASS="twitch-session"');
  assert.includes(r.text, 'X-TV-TWITCH-AD-QUARTILE-URLS="https://twitch.tv"');
  assert.notIncludes(r.text, 'example.invalid/q0');
});
test('stripAds midroll: live before and after kept, one DISCONTINUITY at the gap, sequence unchanged', function () {
  var r = M.stripAds(fixture('midroll.m3u8'), cfg);
  assert.equal(r.removed, 3);
  assert.equal(r.kept, 4);
  var urls = segUrls(r.text);
  assert.deepEqual(urls.map(function (u) { return u.split('/').pop(); }), ['SYNTH-live-7000.ts', 'SYNTH-live-7001.ts', 'SYNTH-live-7005.ts', 'SYNTH-live-7006.ts']);
  assert.deepEqual(tagLines(r.text, '#EXT-X-MEDIA-SEQUENCE'), ['#EXT-X-MEDIA-SEQUENCE:7000']);
  assert.deepEqual(tagLines(r.text, '#EXT-X-DISCONTINUITY-SEQUENCE'), ['#EXT-X-DISCONTINUITY-SEQUENCE:3']);
  var lines = r.text.split('\n');
  var i = lines.indexOf(urls[2]);
  var segBlock = lines.slice(lines.indexOf(urls[1]) + 1, i);
  assert.equal(segBlock.filter(function (l) { return l === '#EXT-X-DISCONTINUITY'; }).length, 1, 'exactly one DISCONTINUITY before the first live segment after the ad');
});
test('stripAds all-ads playlist: no segments left, sequence and discontinuity sequence advanced', function () {
  var r = M.stripAds(fixture('all-ads.m3u8'), cfg);
  assert.equal(r.kept, 0);
  assert.equal(r.removed, 2);
  assert.deepEqual(tagLines(r.text, '#EXT-X-MEDIA-SEQUENCE'), ['#EXT-X-MEDIA-SEQUENCE:52']);
  assert.deepEqual(tagLines(r.text, '#EXT-X-DISCONTINUITY-SEQUENCE'), ['#EXT-X-DISCONTINUITY-SEQUENCE:1']);
  assert.equal(M.countSegments(r.text), 0);
});
test('stripAds clean playlist: unchanged (prefetch kept)', function () {
  var src = fixture('clean.m3u8');
  var r = M.stripAds(src, cfg);
  assert.equal(r.removed, 0);
  assert.equal(r.text, src);
});
test('stripAds maf-ad (client-side): nothing removable, live segments kept, ad DATERANGE dropped', function () {
  var r = M.stripAds(fixture('maf-ad.m3u8'), cfg);
  assert.equal(r.removed, 0);
  assert.equal(r.kept, 2);
  assert.notIncludes(r.text, 'CLASS="twitch-maf-ad"');
});
test('stripAds VOD (ENDLIST): untitled segments are NOT treated as ads', function () {
  var vod = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.000,\n0.ts\n#EXTINF:10.000,\n1.ts\n#EXT-X-ENDLIST\n';
  var r = M.stripAds(vod, cfg);
  assert.equal(r.removed, 0);
  assert.equal(r.text, vod);
});
test('stripAds CUE-OUT/CUE-IN: segments inside the cue are removed', function () {
  var t = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\na.ts\n#EXT-X-CUE-OUT:4\n#EXTINF:2.000,live\nb.ts\n#EXTINF:2.000,live\nc.ts\n#EXT-X-CUE-IN\n#EXTINF:2.000,live\nd.ts\n';
  var r = M.stripAds(t, cfg);
  assert.deepEqual(segUrls(r.text), ['a.ts', 'd.ts']);
  assert.notIncludes(r.text, 'CUE');
});
test('stripAds handles CRLF input', function () {
  var r = M.stripAds(fixture('preroll.m3u8').replace(/\n/g, '\r\n'), cfg);
  assert.equal(r.kept, 2);
  assert.equal(r.removed, 4);
});

// ------------------------------------------------------------------ master / variants
test('parseMaster: all variants with resolution, frame rate, codecs, name', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  assert.equal(v.length, 8);
  var src = v[1];
  assert.equal(src.resolution, '1920x1080');
  assert.equal(src.width, 1920);
  assert.equal(src.frameRate, 60);
  assert.equal(src.codecs, 'avc1.64002A,mp4a.40.2');
  assert.equal(src.name, '1080p60 (source)');
  assert.equal(src.group, 'chunked');
  assert.includes(src.url, 'SYNTH-chunked.m3u8');
  var audio = v[7];
  assert.equal(audio.width, 0);
  assert.equal(audio.name, 'audio_only');
  assert.equal(v.serverTime, '1762891200.00');
});
test('codecFamily', function () {
  assert.equal(M.codecFamily('avc1.64002A,mp4a.40.2', cfg), 'avc');
  assert.equal(M.codecFamily('hvc1.1.2.L153.B0,mp4a.40.2', cfg), 'hevc');
  assert.equal(M.codecFamily('hev1.1.6.L123.B0', cfg), 'hevc');
  assert.equal(M.codecFamily('av01.0.08M.08', cfg), 'av1');
  assert.equal(M.codecFamily('', cfg), 'unknown');
});
test('pickVariant: exact resolution + frame rate', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  var p = M.pickVariant(v, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg, { preferAvc: true });
  assert.includes(p.url, 'SYNTH-720p60.m3u8');
});
test('pickVariant: exact resolution prefers same codec family without preferAvc', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  var p = M.pickVariant(v, { width: 1920, height: 1080, frameRate: 60, codecs: 'hev1.1.6.L123.B0' }, cfg, { preferAvc: false });
  assert.includes(p.url, 'SYNTH-1080p60-hevc.m3u8');
  var q = M.pickVariant(v, { width: 1920, height: 1080, frameRate: 60, codecs: 'hev1.1.6.L123.B0' }, cfg, { preferAvc: true });
  assert.includes(q.url, 'SYNTH-chunked.m3u8');
});
test('pickVariant: closest pixel area when no exact match', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  var p = M.pickVariant(v, { width: 1600, height: 900, frameRate: 60, codecs: 'avc1' }, cfg, { preferAvc: true });
  assert.includes(p.url, 'SYNTH-720p60.m3u8'); // 900p: 720p area (921,600) is closer than 1080p (2,073,600)
  var p2 = M.pickVariant(v, { width: 2560, height: 1440, frameRate: 60, codecs: 'avc1' }, cfg, { preferAvc: true });
  assert.includes(p2.url, 'SYNTH-chunked.m3u8'); // 1440p HEVC excluded by preferAvc -> largest AVC
  var q = M.pickVariant(v, { width: 768, height: 432, frameRate: 30, codecs: 'avc1' }, cfg, { preferAvc: true });
  assert.includes(q.url, 'SYNTH-480p30.m3u8');
  var r = M.pickVariant(v, { width: 160, height: 90, frameRate: 30, codecs: 'avc1' }, cfg, {});
  assert.includes(r.url, 'SYNTH-160p30.m3u8');
});
test('pickVariant: audio-only target picks audio-only variant; empty input -> null', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  assert.includes(M.pickVariant(v, { width: 0, height: 0 }, cfg, {}).url, 'audio_only');
  assert.equal(M.pickVariant([], { width: 1, height: 1 }, cfg, {}), null);
});
test('filterMasterCodecs drops HEVC/AV1 variants when AVC exists', function () {
  var r = M.filterMasterCodecs(fixture('master.m3u8'), cfg);
  assert.equal(r.removed, 2);
  var v = M.parseMaster(r.text);
  assert.equal(v.length, 6);
  v.forEach(function (x) { assert.ok(M.codecFamily(x.codecs, cfg) !== 'hevc', 'no hevc left'); });
  assert.notIncludes(r.text, 'SYNTH-1440p60-hevc.m3u8');
  assert.includes(r.text, '#EXT-X-TWITCH-INFO');
});
test('filterMasterCodecs keeps an HEVC-only master untouched', function () {
  var t = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,CODECS="hev1.1.6"\nhttps://x.invalid/a.m3u8\n';
  assert.equal(M.filterMasterCodecs(t, cfg).text, t);
});

// ------------------------------------------------------------------ URLs
var USHER = 'https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8?acmb=e30%3D&allow_source=true&p=1234&parent_domains=example.invalid&player_backend=mediaplayer&sig=OLDSIG&supported_codecs=av1,h265,h264&token=%7B%22old%22%3Atrue%7D&cdm=wv';
test('buildUsherUrl replaces sig/token, keeps other params, drops parent_domains', function () {
  var u = M.buildUsherUrl(USHER, '{"new":1}', 'NEWSIG', cfg.usherDropParams);
  assert.equal(u.indexOf('https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8?'), 0);
  assert.includes(u, 'acmb=e30%3D');
  assert.includes(u, 'allow_source=true');
  assert.includes(u, 'supported_codecs=av1,h265,h264');
  assert.includes(u, 'cdm=wv');
  assert.includes(u, 'sig=NEWSIG');
  assert.includes(u, 'token=' + encodeURIComponent('{"new":1}'));
  assert.notIncludes(u, 'OLDSIG');
  assert.notIncludes(u, 'old%22');
  assert.notIncludes(u, 'parent_domains');
  assert.equal(u.split('sig=').length, 2, 'exactly one sig');
});
test('buildUsherUrl without query', function () {
  assert.equal(M.buildUsherUrl('https://usher.ttvnw.net/api/channel/hls/a.m3u8', 't', 's', []), 'https://usher.ttvnw.net/api/channel/hls/a.m3u8?sig=s&token=t');
});
test('matchUsher: live v1/v2, VOD, picture-by-picture ignored, other URLs', function () {
  assert.deepEqual(M.matchUsher(USHER, cfg), { kind: 'live', id: 'somechannel' });
  assert.deepEqual(M.matchUsher('https://usher.ttvnw.net/api/channel/hls/SomeChannel.m3u8?x=1', cfg), { kind: 'live', id: 'somechannel' });
  assert.deepEqual(M.matchUsher('https://usher.ttvnw.net/vod/123456.m3u8?x=1', cfg), { kind: 'vod', id: '123456' });
  assert.equal(M.matchUsher('https://usher.ttvnw.net/api/channel/hls/a.m3u8?x=picture-by-picture', cfg), null);
  assert.equal(M.matchUsher('https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/a.m3u8', cfg), null);
});
test('removeQueryParams and isM3u8Url', function () {
  assert.equal(M.removeQueryParams('https://a.invalid/x.m3u8?a=1&parent_domains=z&b=2', ['parent_domains']), 'https://a.invalid/x.m3u8?a=1&b=2');
  assert.ok(M.isM3u8Url('https://a.invalid/x.m3u8?a=1'));
  assert.notOk(M.isM3u8Url('https://a.invalid/x.ts?m3u8'));
});

// ------------------------------------------------------------------ resequence (player-facing numbering)
var SEG_BASE = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/';
var T0 = Date.parse('2025-11-11T20:00:00.000Z');
/** Synthetic live playlist. segs: [{id, ad?, disc?}]; a segment's time is id*2 s (+ skewMs). */
function pl(o) {
  var lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:' + o.seq];
  if (o.dseq !== undefined) lines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + o.dseq);
  if (o.live !== undefined) lines.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + o.live);
  if (o.segs.some(function (s) { return s.ad; })) {
    lines.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:00:00.000Z",DURATION=4.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"');
  }
  o.segs.forEach(function (s) {
    if (s.disc) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + s.id * 2000 + (o.skewMs || 0)).toISOString());
    lines.push('#EXTINF:2.000,' + (s.ad ? 'Amazon|1' : 'live'));
    lines.push(SEG_BASE + (s.ad ? 'ad-' : (o.prefix || 'native-')) + s.id + '.ts');
  });
  return lines.join('\n') + '\n';
}
function ids(from, to, extra) {
  var a = [];
  for (var i = from; i <= to; i++) a.push(Object.assign({ id: i }, extra || {}));
  return a;
}
/** url -> number as the player sees it; checks numbers are consecutive within the playlist. */
function numbering(text) {
  var p = M.parseMedia(text);
  var map = {};
  p.segs.forEach(function (s, i) { map[s.url] = p.mediaSeq + i; });
  return { map: map, seq: p.mediaSeq, dseq: p.discSeq, urls: p.segs.map(function (s) { return s.url; }), segs: p.segs };
}
function short(u) { return u.replace(SEG_BASE, ''); }

test('resequence: a segment keeps its number across polls around a mid-playlist gap, numbering stays continuous', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 100, live: 100, segs: ids(100, 102) });
  var polls = [
    pl({ seq: 100, live: 100, segs: ids(100, 102).concat([{ id: 103, ad: true }, { id: 104, ad: true }, { id: 105, disc: true }, { id: 106 }]) }),
    pl({ seq: 102, live: 102, segs: [{ id: 102 }, { id: 103, ad: true }, { id: 104, ad: true }, { id: 105, disc: true }].concat(ids(106, 107)) }),
    pl({ seq: 105, live: 105, segs: ids(105, 108) })
  ];
  var given = {};
  given[SEG_BASE + 'native-100.ts'] = 100; given[SEG_BASE + 'native-101.ts'] = 101; given[SEG_BASE + 'native-102.ts'] = 102;
  var lastSeq = 100, lastDseq = 0;
  polls.forEach(function (raw, n) {
    var src = M.hasAds(raw, cfg) ? M.stripAds(raw, cfg).text : raw;
    var r = M.resequence(st, src, 'native', cfg.sequencer);
    var num = numbering(r.text);
    assert.ok(num.seq >= lastSeq, 'MEDIA-SEQUENCE never goes back (poll ' + n + ')');
    assert.ok(num.dseq >= lastDseq, 'DISCONTINUITY-SEQUENCE never goes back (poll ' + n + ')');
    lastSeq = num.seq; lastDseq = num.dseq;
    num.urls.forEach(function (u) {
      assert.notIncludes(u, '/ad-', 'no ad segment listed');
      if (given[u] !== undefined) assert.equal(num.map[u], given[u], short(u) + ' keeps its number (poll ' + n + ')');
      else given[u] = num.map[u];
    });
    assert.notOk(r.repeat);
  });
  assert.deepEqual([105, 106, 107, 108].map(function (i) { return given[SEG_BASE + 'native-' + i + '.ts']; }), [103, 104, 105, 106],
    'live segments after the removed ads continue the numbering without a jump');
  var last = numbering(M.resequence(st, polls[2], 'native', cfg.sequencer).text);
  assert.equal(last.dseq, 1, 'the DISCONTINUITY before 105 slid out and is counted');
});

test('resequence: DISCONTINUITY only where timestamps jump, never on the first listed segment', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 10, live: 10, segs: ids(10, 12) });
  var r = M.resequence(st, M.stripAds(pl({ seq: 11, live: 11, segs: ids(11, 12).concat([{ id: 13, ad: true }, { id: 14, disc: true }]) }), cfg).text, 'native', cfg.sequencer);
  var lines = r.text.split('\n');
  var i14 = lines.indexOf(SEG_BASE + 'native-14.ts');
  assert.equal(lines.slice(lines.indexOf(SEG_BASE + 'native-12.ts') + 1, i14).filter(function (l) { return l === '#EXT-X-DISCONTINUITY'; }).length, 1);
  var first = lines.findIndex(function (l) { return l.indexOf('#EXTINF') === 0 || l === '#EXT-X-DISCONTINUITY'; });
  assert.ok(lines[first] !== '#EXT-X-DISCONTINUITY' || first > lines.indexOf(SEG_BASE + 'native-10.ts'));
});

test('resequence (F-27): backup numbered by live sequence, not its own MEDIA-SEQUENCE; no segment handed twice at switch-in and break end', function () {
  var st = M.newSequenceState();
  // The page's playlist is numbered 100 ahead of the live sequence (earlier stitched breaks).
  st.passthrough = pl({ seq: 500, live: 400, segs: ids(400, 403) });
  // Backup: own numbering (9001...), dated 1.6 s later than the page's playlist.
  var backup = pl({ seq: 9001, live: 401, prefix: 'popout-', skewMs: 1600, segs: ids(401, 405) });
  var r = M.resequence(st, backup, 'backup:popout:1280x720:60', cfg.sequencer);
  var num = numbering(r.text);
  assert.deepEqual(num.urls.map(short), ['native-401.ts', 'native-402.ts', 'native-403.ts', 'popout-404.ts', 'popout-405.ts'],
    'backup copies of 401-403 (already given) are not listed again');
  assert.equal(num.map[SEG_BASE + 'popout-404.ts'], 504, 'continues the page numbering');
  assert.equal(num.segs[3].disc, true, 'DISCONTINUITY before the first backup segment');
  assert.equal(num.segs[4].disc, false);
  assert.notOk(r.repeat);
  // Break end: the page's playlist comes back numbered 4 further ahead (B-054).
  var back = pl({ seq: 508, live: 404, segs: ids(404, 407) });
  var r2 = M.resequence(st, back, 'native', cfg.sequencer);
  var num2 = numbering(r2.text);
  assert.deepEqual(num2.urls.map(short), ['popout-404.ts', 'popout-405.ts', 'native-406.ts', 'native-407.ts']);
  assert.equal(num2.seq, 504);
  assert.equal(num2.map[SEG_BASE + 'native-406.ts'], 506, 'no jump, no repeat');
  assert.equal(num2.segs[2].disc, true, 'DISCONTINUITY at the switch back');
  assert.equal(num2.dseq, num.dseq + 1, 'the DISCONTINUITY before 404 is now before the first listed segment: counted');
  assert.notOk(r2.repeat);
});

test('resequence (F-28): repeat detected when a switched-to playlist without live numbers overlaps what was given', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 0, segs: ids(0, 3) });
  // No live sequence; the backup dates its segments 1.6 s earlier, so its segment 4 overlaps native 3.
  var r = M.resequence(st, pl({ seq: 70, prefix: 'popout-', skewMs: -1600, segs: ids(1, 5) }), 'backup:popout', cfg.sequencer);
  assert.ok(r.repeat, 'repeat flagged');
  var num = numbering(r.text);
  assert.equal(num.urls.indexOf(SEG_BASE + 'popout-3.ts'), -1, 'fully covered segment skipped');
  assert.equal(num.map[SEG_BASE + 'popout-4.ts'], 4);
  // Same source, next poll: nothing new overlaps, no repeat.
  var r2 = M.resequence(st, pl({ seq: 71, prefix: 'popout-', skewMs: -1600, segs: ids(2, 6) }), 'backup:popout', cfg.sequencer);
  assert.notOk(r2.repeat);
});

test('resequence: an all-stripped poll lists the newest known segments again (same numbers), hold keeps them too', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 20, live: 20, segs: ids(20, 23) });
  var empty = M.stripAds(pl({ seq: 24, live: 24, segs: [{ id: 24, ad: true }, { id: 25, ad: true }] }), cfg).text;
  var n1 = numbering(M.resequence(st, empty, 'native', cfg.sequencer).text);
  assert.deepEqual(n1.urls.map(short), ['native-21.ts', 'native-22.ts', 'native-23.ts']);
  assert.equal(n1.seq, 21);
  var n2 = numbering(M.resequence(st, null, 'native', cfg.sequencer).text);
  assert.deepEqual(n2.urls, n1.urls);
  assert.equal(n2.seq, 21);
});

test('pickVariant prefers the exact CODECS string among equal resolutions', function () {
  var vs = [
    { url: 'a', width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F,mp4a.40.2', bandwidth: 9 },
    { url: 'b', width: 1280, height: 720, frameRate: 60, codecs: 'avc1.64002A,mp4a.40.2', bandwidth: 1 }
  ];
  var t = { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.64002A,mp4a.40.2' };
  assert.equal(M.pickVariant(vs, t, cfg, { preferAvc: true }).url, 'b');
});
