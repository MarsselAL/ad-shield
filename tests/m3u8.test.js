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
// TTV-AB issue #98: twitch-maf-ad (client-side ad, a separate video beside the stream) appears in
// playlists whose segments are all `live`. It is not a stitched ad: nothing to replace or strip.
test('hasAds: twitch-maf-ad DATERANGE over all-live segments is NOT an ad (client-side ad)', function () {
  assert.notOk(M.hasAds(fixture('maf-ad.m3u8'), cfg));
  assert.equal(cfg.adMarkers.filter(function (m) { return m.indexOf('maf') !== -1; }).length, 0);
  assert.equal(cfg.adDaterangeClasses.indexOf('twitch-maf-ad'), -1);
  assert.ok(cfg.clientAdDaterangeClasses.indexOf('twitch-maf-ad') !== -1);
});
test('hasAds: twitch-maf-ad together with a stitched ad segment is an ad (by the segment)', function () {
  var t = fixture('maf-ad.m3u8').replace('#EXTINF:2.000,live\nhttps://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-301.ts',
    '#EXTINF:2.000,Amazon|123\nhttps://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-ad-301.ts');
  assert.ok(t !== fixture('maf-ad.m3u8'));
  assert.ok(M.hasAds(t, cfg));
});
test('hasAds: ad segment titles alone (no marker) are ads in a live playlist', function () {
  assert.ok(M.hasAds('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,Amazon|9\nb.ts\n', cfg), 'Amazon title');
  assert.ok(M.hasAds('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,\nb.ts\n', cfg), 'untitled in live');
  assert.notOk(M.hasAds('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,live\nb.ts\n', cfg), 'all live');
  assert.notOk(M.hasAds('#EXTM3U\n#EXTINF:10.000,\n0.ts\n#EXT-X-ENDLIST\n', cfg), 'VOD untitled');
});
test('hasAds/stripAds: FT|n-n-n and bare numeric ad titles (no stitched marker) are ads; live segments kept', function () {
  var t = fixture('midroll-ft.m3u8');
  assert.ok(M.hasAds(t, cfg));
  var r = M.stripAds(t, cfg);
  assert.equal(r.removed, 3);
  assert.equal(r.kept, 4);
  assert.deepEqual(segUrls(r.text).map(function (u) { return u.replace(/.*SYNTH-/, ''); }),
    ['live-8000.ts', 'live-8001.ts', 'live-8005.ts', 'live-8006.ts']);
  assert.equal(tagLines(r.text, '#EXT-X-DATERANGE').length, 5, 'stream-source / session DATERANGEs kept');
  assert.notIncludes(r.text, '#EXT-X-TWITCH-PREFETCH', 'prefetch removed in an ad context');
});
test('hasAds: FT| and numeric titles are ads even where the not-live rule does not apply (ENDLIST)', function () {
  function vod(title) {
    return '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:2.000,\nhttps://x.invalid/a.ts\n#EXTINF:2.000,' + title + '\nhttps://x.invalid/b.ts\n#EXT-X-ENDLIST\n';
  }
  assert.ok(M.hasAds(vod('FT|10-20-30'), cfg));
  assert.ok(M.hasAds(vod('4012345678'), cfg));
  assert.notOk(M.hasAds(vod(''), cfg), 'untitled VOD segments are not ads');
  assert.notOk(M.hasAds(vod('123'), cfg), 'short numbers are not ad ids');
  assert.equal(M.stripAds(vod('FT|10-20-30'), cfg).removed, 1);
});
test('hasAds: normal live segments (with stream-source "live" DATERANGE and maf-ad) are not ads', function () {
  var t = fixture('maf-ad.m3u8').replace('#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:00.000Z',
    '#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="2025-11-11T20:00:00.000Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"\n#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:00.000Z');
  assert.notOk(M.hasAds(t, cfg));
  assert.notOk(M.hasAds(fixture('clean.m3u8').replace(/,live\n/g, ',live \n'), cfg), 'trailing space in the title');
  assert.equal(M.stripAds(fixture('clean.m3u8'), cfg).removed, 0);
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
  var maf = M.classifyDateranges(fixture('maf-ad.m3u8'), cfg);
  assert.deepEqual(maf.ad, []);
  assert.deepEqual(maf.client, ['twitch-maf-ad']);
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
test('stripAds maf-ad only (client-side): nothing changed (DATERANGE and prefetch kept)', function () {
  var src = fixture('maf-ad.m3u8');
  var r = M.stripAds(src, cfg);
  assert.equal(r.removed, 0);
  assert.equal(r.kept, 2);
  assert.equal(r.text, src);
});
test('stripAds stitched ad + maf-ad: ad segment removed, maf-ad DATERANGE kept with tracking URLs neutralised', function () {
  var src = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n' +
    '#EXT-X-DATERANGE:ID="m1",CLASS="twitch-maf-ad",START-DATE="2025-11-11T20:00:00.000Z",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://ads.example.invalid/t?x=1"\n' +
    '#EXT-X-DATERANGE:ID="s1",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:00:00.000Z",DURATION=2.000\n' +
    '#EXTINF:2.000,live\nlive-10.ts\n#EXTINF:2.000,live\nlive-11.ts\n#EXTINF:2.000,Amazon|1\nad-12.ts\n';
  var r = M.stripAds(src, cfg);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.removedUrls, ['ad-12.ts']);
  assert.notIncludes(r.text, 'twitch-stitched-ad');
  assert.includes(r.text, 'CLASS="twitch-maf-ad"');
  assert.notIncludes(r.text, 'ads.example.invalid');
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
  var p = M.pickVariant(v, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg);
  assert.includes(p.url, 'SYNTH-720p60.m3u8');
});
test('pickVariant: same resolution must also be the same codec family', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  assert.includes(M.pickVariant(v, { width: 1920, height: 1080, frameRate: 60, codecs: 'hev1.1.6.L123.B0' }, cfg).url, 'SYNTH-1080p60-hevc.m3u8');
  assert.includes(M.pickVariant(v, { width: 1920, height: 1080, frameRate: 60, codecs: 'avc1.64002A' }, cfg).url, 'SYNTH-chunked.m3u8');
  // 1440p exists only as HEVC: an AVC 1440p target gets nothing (no codec switch).
  assert.equal(M.pickVariant(v, { width: 2560, height: 1440, frameRate: 60, codecs: 'avc1.64002A' }, cfg), null);
});
test('pickVariant: no variant of the exact resolution -> null (never a lower or other quality)', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  assert.equal(M.pickVariant(v, { width: 1600, height: 900, frameRate: 60, codecs: 'avc1' }, cfg), null);
  assert.equal(M.pickVariant(v, { width: 768, height: 432, frameRate: 30, codecs: 'avc1' }, cfg), null);
  assert.equal(M.pickVariant(v, { width: 1280, height: 721, frameRate: 60, codecs: 'avc1' }, cfg), null, 'height must match');
  assert.equal(M.pickVariant(v, { width: 1279, height: 720, frameRate: 60, codecs: 'avc1' }, cfg), null, 'width must match');
  // A 360p-only backup master (autoplay-like) never stands in for 720p.
  var only360 = v.filter(function (x) { return x.height === 360; });
  assert.equal(M.pickVariant(only360, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg), null);
});
test('pickVariant anyResolution (last-resort bridge): highest same-family video not above the target; audio stays exact', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  var only360 = v.filter(function (x) { return x.height === 360; });
  assert.equal(M.pickVariant(only360, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg, { anyResolution: true }).height, 360);
  var avc = v.filter(function (x) { return x.codecs.indexOf('avc1') === 0; });
  assert.equal(M.pickVariant(avc, { width: 1600, height: 900, frameRate: 60, codecs: 'avc1' }, cfg, { anyResolution: true }).height, 720, 'highest not above 900');
  assert.equal(M.pickVariant(avc, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1' }, cfg, { anyResolution: true }).url, M.pickVariant(avc, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1' }, cfg).url, 'exact when available');
  var hevcOnly = v.filter(function (x) { return x.codecs.indexOf('hev1') === 0 || x.codecs.indexOf('hvc1') === 0; });
  assert.equal(M.pickVariant(hevcOnly, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1' }, cfg, { anyResolution: true }), null, 'never another codec family');
  var audio = M.pickVariant(only360, { width: 0, height: 0, codecs: 'mp4a.40.2' }, cfg, { anyResolution: true });
  assert.equal(audio, null, 'audio-only target: no video variant');
});
test('pickVariant: same resolution, other frame rate is still accepted; equal frame rate preferred', function () {
  var vs = [
    { url: 'a', width: 1280, height: 720, frameRate: 30, codecs: 'avc1.4D401F', bandwidth: 9 },
    { url: 'b', width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F', bandwidth: 1 }
  ];
  assert.equal(M.pickVariant(vs, { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg).url, 'b');
  assert.equal(M.pickVariant(vs.slice(0, 1), { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F' }, cfg).url, 'a');
});
test('pickVariant: audio-only target picks audio-only variant; empty input -> null', function () {
  var v = M.parseMaster(fixture('master.m3u8'));
  assert.includes(M.pickVariant(v, { width: 0, height: 0, codecs: 'mp4a.40.2' }, cfg).url, 'audio_only');
  assert.equal(M.pickVariant([], { width: 1, height: 1 }, cfg), null);
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
test('isClientAdUrl: Twitch / Amazon client-side ad request URLs only (origin + exact path)', function () {
  ['https://edge.ads.twitch.tv/ads?bp=preroll&sid=1', 'https://edge.ads.twitch.tv/ads/format', 'https://edge.ads.twitch.tv/ads#x',
    'https://vaes.amazon-adsystem.com/2018-01-01/3p/ads?a=1'].forEach(function (u) { assert.ok(M.isClientAdUrl(u, cfg), u); });
  ['https://edge.ads.twitch.tv/', 'https://edge.ads.twitch.tv/adsx', 'https://edge.ads.twitch.tv/ads/other',
    'https://edge.ads.twitch.tv.evil.net/ads', 'http://edge.ads.twitch.tv/ads', 'https://gql.twitch.tv/gql',
    'https://evil.net/x?u=https://edge.ads.twitch.tv/ads', '', null].forEach(function (u) { assert.notOk(M.isClientAdUrl(u, cfg), String(u)); });
});
test('isVodPage: /videos/<id> and the embedded player with ?video=; channels, clips, other params are not', function () {
  assert.ok(M.isVodPage('/videos/2345678901', '', cfg));
  assert.ok(M.isVodPage('/videos/2345678901', '?t=1h2m', cfg));
  assert.ok(M.isVodPage('/', '?video=v2345678901&parent=example.com', cfg));
  assert.ok(M.isVodPage('/', 'parent=example.com&video=123', cfg));
  assert.notOk(M.isVodPage('/somechannel', '', cfg));
  assert.notOk(M.isVodPage('/somechannel/videos', '', cfg), 'a channel\'s video list is not playback');
  assert.notOk(M.isVodPage('/videos/', '', cfg));
  assert.notOk(M.isVodPage('/', '?channel=somechannel&parent=example.com', cfg));
  assert.notOk(M.isVodPage('/', '?video=', cfg));
  assert.notOk(M.isVodPage('/', '?xvideo=1', cfg));
  assert.notOk(M.isVodPage(undefined, undefined, cfg));
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
  // fMP4 (o.map / s.map: init segment name): header MAP, or DISCONTINUITY + MAP before a segment.
  if (o.map) lines.push(mapLine(o.map));
  o.segs.forEach(function (s) {
    if (s.disc) lines.push('#EXT-X-DISCONTINUITY');
    if (s.map) lines.push(mapLine(s.map));
    lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + s.id * 2000 + (o.skewMs || 0)).toISOString());
    lines.push('#EXTINF:2.000,' + (s.ad ? 'Amazon|1' : 'live'));
    lines.push(SEG_BASE + (s.ad ? 'ad-' : (o.prefix || 'native-')) + s.id + (o.map || s.map ? '.mp4' : '.ts'));
  });
  return lines.join('\n') + '\n';
}
function mapLine(name) { return '#EXT-X-MAP:URI="' + SEG_BASE + 'init-' + name + '.mp4"'; }
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

test('resequence: an all-stripped poll lists the newest known segments again (same numbers)', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 20, live: 20, segs: ids(20, 23) });
  var empty = M.stripAds(pl({ seq: 24, live: 24, segs: [{ id: 24, ad: true }, { id: 25, ad: true }] }), cfg).text;
  var n1 = numbering(M.resequence(st, empty, 'native', cfg.sequencer).text);
  assert.deepEqual(n1.urls.map(short), ['native-21.ts', 'native-22.ts', 'native-23.ts']);
  assert.equal(n1.seq, 21);
  var n2 = numbering(M.resequence(st, empty, 'native', cfg.sequencer).text);
  assert.deepEqual(n2.urls, n1.urls);
  assert.equal(n2.seq, 21);
});

test('pickVariant prefers the exact CODECS string among equal resolutions', function () {
  var vs = [
    { url: 'a', width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F,mp4a.40.2', bandwidth: 9 },
    { url: 'b', width: 1280, height: 720, frameRate: 60, codecs: 'avc1.64002A,mp4a.40.2', bandwidth: 1 }
  ];
  var t = { width: 1280, height: 720, frameRate: 60, codecs: 'avc1.64002A,mp4a.40.2' };
  assert.equal(M.pickVariant(vs, t, cfg).url, 'b');
});

// ------------------------------------------------------------------ fMP4 init segments (EXT-X-MAP)
// A MAP applies to every following segment until the next MAP (RFC 8216 §4.3.2.5). Listing a
// segment under another source's MAP makes the player decode it with the wrong init segment:
// picture lost, audio plays (twitch.tv/lirik, 2026-11-17).

/** For each segment URL in order: the MAP URI in force for it, by RFC rules. */
function effectiveMaps(text) {
  var cur = null, res = [];
  text.split('\n').forEach(function (l) {
    if (l.indexOf('#EXT-X-MAP:') === 0) cur = /URI="([^"]*)"/.exec(l)[1];
    else if (l && l[0] !== '#') res.push({ url: l, map: cur });
  });
  return res;
}
function mapUri(name) { return SEG_BASE + 'init-' + name + '.mp4'; }
/** Every MAP line is the first line of a segment (first listed one, or right after a DISCONTINUITY)
 *  and is directly followed by that segment's own tags: never in the header block. */
function assertMapPlacement(text, label) {
  var lines = text.split('\n');
  var firstSeg = lines.findIndex(function (l) { return l === '#EXT-X-DISCONTINUITY' || l.indexOf('#EXT-X-PROGRAM-DATE-TIME') === 0 || l.indexOf('#EXTINF') === 0 || l.indexOf('#EXT-X-MAP') === 0; });
  lines.forEach(function (l, i) {
    if (l.indexOf('#EXT-X-MAP:') !== 0) return;
    assert.ok(i === firstSeg || lines[i - 1] === '#EXT-X-DISCONTINUITY', label + ': MAP at line ' + i + ' starts a segment');
    assert.ok(/^#EXT-X-(PROGRAM-DATE-TIME|BYTERANGE)|^#EXTINF/.test(lines[i + 1] || ''), label + ': MAP at line ' + i + ' is followed by its segment');
  });
  lines.slice(0, firstSeg).forEach(function (l) { assert.notIncludes(l, '#EXT-X-MAP', label + ': no MAP in the header block'); });
}

test('parseMedia: every segment carries the MAP in force for it; MAP lines leave header and tags', function () {
  var p = M.parseMedia(fixture('fmp4-midroll.m3u8'));
  var live = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-init-1080.mp4';
  var ad = 'https://synth0000.cloudfront.hls.ttvnw.net/SYNTH-ad-init.mp4';
  assert.deepEqual(p.segs.map(function (s) { return /URI="([^"]*)"/.exec(s.map)[1]; }), [live, live, ad, ad, live, live]);
  p.header.concat.apply(p.header, p.segs.map(function (s) { return s.tags; })).forEach(function (l) {
    assert.notIncludes(l, '#EXT-X-MAP');
  });
  assert.equal(M.parseMedia(fixture('clean.m3u8')).segs[0].map, null, 'TS: no MAP');
});

/** Stitched preroll as captured on Twitch: LIVE-SEQUENCE numbers the first LIVE segment. */
function stitchedPreroll(liveSeq, ads, live) {
  var l = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-TWITCH-LIVE-SEQUENCE:' + liveSeq,
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:00:00.000Z",DURATION=15.235,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"'];
  for (var a = 0; a < ads; a++) {
    if (a === 0) l.push('#EXT-X-DISCONTINUITY');
    l.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + a * 2000).toISOString(), '#EXTINF:2.000,Amazon|248888310', SEG_BASE + 'ad-' + a + '.ts');
  }
  for (var i = 0; i < live; i++) {
    if (i === 0) l.push('#EXT-X-DISCONTINUITY');
    l.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + (ads + i) * 2000).toISOString(), '#EXTINF:2.000,live', SEG_BASE + 'live-' + (liveSeq + i) + '.ts');
  }
  return l.join('\n') + '\n';
}

test('parseMedia: stitched preroll: ad segments get no live number, LIVE-SEQUENCE is the first live segment', function () {
  var p = M.parseMedia(stitchedPreroll(58602, 8, 3));
  assert.equal(p.liveSeq, 58602);
  assert.deepEqual(p.segs.map(function (s) { return s.live; }), [null, null, null, null, null, null, null, null, 58602, 58603, 58604]);
});

test('parseMedia: live-titled numbering stops at a DISCONTINUITY between live segments and at an ad after the run', function () {
  var midroll = pl({ seq: 10, live: 10, segs: ids(10, 11).concat([{ id: 12, ad: true }, { id: 13, disc: true }]) });
  assert.deepEqual(M.parseMedia(midroll).segs.map(function (s) { return s.live; }), [10, 11, null, null], 'ad after the run');
  var split = pl({ seq: 10, live: 10, segs: ids(10, 11).concat([{ id: 12, disc: true }]) });
  assert.deepEqual(M.parseMedia(split).segs.map(function (s) { return s.live; }), [10, 11, null], 'DISCONTINUITY between live segments');
});

test('parseMedia: no live titles: first segment numbered, counting up to the first DISCONTINUITY (unchanged)', function () {
  var text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-TWITCH-LIVE-SEQUENCE:700',
    '#EXTINF:2.000,', 'a.ts', '#EXTINF:2.000,', 'b.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:2.000,', 'c.ts'].join('\n') + '\n';
  assert.deepEqual(M.parseMedia(text).segs.map(function (s) { return s.live; }), [700, 701, null]);
});

test('resequence seeded from a passed-through stitched preroll keeps the live segments that follow', function () {
  var st = M.newSequenceState();
  st.passthrough = stitchedPreroll(58602, 8, 2);
  var next = M.stripAds(stitchedPreroll(58602, 8, 4), cfg).text;
  var r = M.resequence(st, next, 'native', cfg.sequencer);
  var urls = segUrls(r.text).map(short);
  assert.deepEqual(urls.slice(-2), ['live-58604.ts', 'live-58605.ts'], 'new live segments appended');
  assert.equal(r.appended, 2);
  assert.equal(tagLines(r.text, '#EXT-X-TWITCH-LIVE-SEQUENCE:')[0], '#EXT-X-TWITCH-LIVE-SEQUENCE:58602', 'header = first live segment listed');
});

test('parseMedia: ad-only preroll poll that already has LIVE-SEQUENCE (no live segment yet): nothing numbered', function () {
  var text = stitchedPreroll(58602, 8, 0) + '#EXT-X-DISCONTINUITY\n';
  assert.deepEqual(M.parseMedia(text).segs.map(function (s) { return s.live; }), [null, null, null, null, null, null, null, null]);
});

test('resequence seeded from an ad-only preroll with LIVE-SEQUENCE keeps the live segments that follow (kaicenat 2026-11-19)', function () {
  var st = M.newSequenceState();
  st.passthrough = stitchedPreroll(58602, 8, 0) + '#EXT-X-DISCONTINUITY\n';
  var next = M.stripAds(stitchedPreroll(58602, 8, 3), cfg).text;
  var r = M.resequence(st, next, 'native', cfg.sequencer);
  assert.deepEqual(segUrls(r.text).map(short).slice(-3), ['live-58602.ts', 'live-58603.ts', 'live-58604.ts']);
  assert.equal(r.appended, 3);
});

test('stripAds fMP4 pre-roll (100% ad): no segments and no ad MAP left', function () {
  var r = M.stripAds(fixture('fmp4-preroll.m3u8'), cfg);
  assert.equal(r.kept, 0);
  assert.equal(r.removed, 3);
  assert.notIncludes(r.text, '#EXT-X-MAP');
  assert.notIncludes(r.text, 'SYNTH-ad-init');
  assert.equal(M.countSegments(r.text), 0);
});

test('stripAds fMP4 midroll: live MAPs kept, ad MAP gone, live MAP again after the discontinuity', function () {
  var live = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-init-1080.mp4';
  var src = fixture('fmp4-midroll.m3u8');
  var r = M.stripAds(src, cfg);
  assert.equal(r.kept, 4);
  assert.notIncludes(r.text, 'SYNTH-ad-init');
  assert.deepEqual(effectiveMaps(r.text).map(function (e) { return e.map; }), [live, live, live, live]);
  assert.equal(tagLines(r.text, '#EXT-X-MAP').length, 2, 'once for the first segment, once after the discontinuity');
  var lines = r.text.split('\n');
  var i5971 = lines.findIndex(function (l) { return /SYNTH-live-5971/.test(l); });
  assert.deepEqual(lines.slice(i5971 - 4, i5971 - 2), ['#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="' + live + '"']);
  // Same playlist, but the live segments after the ad carry no MAP of their own (only the
  // header one): the ad's MAP must not apply to them; the live MAP is written after the gap.
  var noOwn = src.replace(/(#EXT-X-DISCONTINUITY\n)#EXT-X-MAP:URI="[^"]*SYNTH-live-init[^"]*"\n/, '$1');
  assert.equal(tagLines(noOwn, '#EXT-X-MAP').length, 2, 'fixture edit applied');
  var r2 = M.stripAds(noOwn, cfg);
  assert.equal(r2.kept, 4);
  assert.notIncludes(r2.text, 'SYNTH-ad-init');
  assert.deepEqual(effectiveMaps(r2.text).map(function (e) { return e.map; }), [live, live, live, live]);
  var l2 = r2.text.split('\n');
  var j = l2.findIndex(function (l) { return /SYNTH-live-5971/.test(l); });
  assert.deepEqual(l2.slice(j - 4, j - 2), ['#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="' + live + '"']);
  assertMapPlacement(r.text, 'own MAP');
  assertMapPlacement(r2.text, 'header MAP');
});

test('resequence fMP4: native (MAP A) -> backup (MAP B) -> native (MAP A): each segment under its own MAP', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 100, live: 100, map: 'A', segs: ids(100, 102) });
  var polls = [
    { text: pl({ seq: 9000, live: 101, prefix: 'embed-', map: 'B', segs: ids(101, 105) }), src: 'backup:embed:640x360:30:avc1' },
    { text: pl({ seq: 9001, live: 102, prefix: 'embed-', map: 'B', segs: ids(102, 106) }), src: 'backup:embed:640x360:30:avc1' },
    { text: pl({ seq: 106, live: 105, map: 'A', segs: ids(105, 109) }), src: 'native' },
    { text: pl({ seq: 107, live: 106, map: 'A', segs: ids(106, 110) }), src: 'native' }
  ];
  var given = {}, lastSeq = 0, sawB = false;
  polls.forEach(function (poll, n) {
    var text = M.resequence(st, poll.text, poll.src, cfg.sequencer).text;
    var label = 'poll ' + n;
    assertMapPlacement(text, label);
    var eff = effectiveMaps(text);
    eff.forEach(function (e) {
      var want = e.url.indexOf('/embed-') !== -1 ? mapUri('B') : mapUri('A');
      if (want === mapUri('B')) sawB = true;
      assert.equal(e.map, want, label + ': ' + short(e.url) + ' under its own MAP');
    });
    // A MAP line at every change, with a DISCONTINUITY.
    var lines = text.split('\n'), prev = null;
    eff.forEach(function (e, k) {
      if (k > 0 && e.map !== prev) {
        var at = lines.indexOf(e.url);
        var block = lines.slice(lines.indexOf(eff[k - 1].url) + 1, at);
        assert.deepEqual(block.slice(0, 2), ['#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="' + e.map + '"'], label + ': DISCONTINUITY + MAP before ' + short(e.url));
      }
      prev = e.map;
    });
    var num = numbering(text);
    assert.ok(num.seq >= lastSeq, label + ': MEDIA-SEQUENCE never goes back');
    lastSeq = num.seq;
    num.urls.forEach(function (u) {
      if (given[u] !== undefined) assert.equal(num.map[u], given[u], label + ': ' + short(u) + ' keeps its number');
      else given[u] = num.map[u];
    });
  });
  assert.ok(sawB, 'backup segments were listed');
  var all = Object.keys(given).map(function (u) { return given[u]; }).sort(function (a, b) { return a - b; });
  for (var i = 1; i < all.length; i++) assert.equal(all[i], all[i - 1] + 1, 'numbering continuous');
});

test('resequence fMP4 first load: empty stripped pre-roll, then backup -> backup MAP before its first segment', function () {
  var st = M.newSequenceState();
  var empty = M.stripAds(fixture('fmp4-preroll.m3u8'), cfg).text;
  var r0 = M.resequence(st, empty, 'native', cfg.sequencer).text;
  assert.notIncludes(r0, '#EXT-X-MAP');
  assert.equal(M.countSegments(r0), 0);
  var r1 = M.resequence(st, pl({ seq: 5967, live: 5967, prefix: 'embed-', map: 'B', segs: ids(5967, 5981) }), 'backup:embed:640x360:30:avc1', cfg.sequencer).text;
  assertMapPlacement(r1, 'first backup poll');
  var lines = r1.split('\n');
  var firstMap = lines.findIndex(function (l) { return l.indexOf('#EXT-X-MAP') === 0; });
  var firstSegTag = lines.findIndex(function (l) { return l.indexOf('#EXT-X-PROGRAM-DATE-TIME') === 0 || l.indexOf('#EXTINF') === 0; });
  assert.equal(lines[firstMap], '#EXT-X-MAP:URI="' + mapUri('B') + '"');
  assert.equal(firstMap, firstSegTag - 1, 'MAP directly before the first segment');
  effectiveMaps(r1).forEach(function (e) { assert.equal(e.map, mapUri('B')); });
  assert.equal(tagLines(r1, '#EXT-X-MAP').length, 1);
});

test('resequence fMP4: a MAP change inside one source forces a DISCONTINUITY', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 10, live: 10, map: 'A', segs: ids(10, 12) });
  var r = M.resequence(st, pl({ seq: 11, live: 11, map: 'A', segs: ids(11, 12).concat([{ id: 13, map: 'C' }, { id: 14 }]) }), 'native', cfg.sequencer).text;
  var num = numbering(r);
  assert.deepEqual(num.urls.map(short), ['native-11.mp4', 'native-12.mp4', 'native-13.mp4', 'native-14.mp4']);
  assert.equal(num.segs[2].disc, true, 'DISCONTINUITY where the init segment changes');
  assert.equal(num.segs[3].disc, false);
  assert.deepEqual(effectiveMaps(r).map(function (e) { return e.map; }), [mapUri('A'), mapUri('A'), mapUri('C'), mapUri('C')]);
  assertMapPlacement(r, 'in-source change');
});

test('resequence fMP4: a MAP that slid out of the window is written again for the first listed segment', function () {
  var st = M.newSequenceState();
  st.passthrough = pl({ seq: 10, live: 10, map: 'A', segs: ids(10, 12) });
  M.resequence(st, pl({ seq: 11, live: 11, map: 'A', segs: ids(11, 12).concat([{ id: 13, disc: true, map: 'C' }, { id: 14 }]) }), 'native', cfg.sequencer);
  // Next poll: Twitch now puts MAP C in the header; our window still starts at 12 (MAP A).
  var r = M.resequence(st, pl({ seq: 13, live: 13, map: 'C', segs: ids(13, 15) }), 'native', cfg.sequencer).text;
  var eff = effectiveMaps(r);
  assert.deepEqual(eff.map(function (e) { return short(e.url) + ' ' + e.map.replace(SEG_BASE, ''); }),
    ['native-13.mp4 init-C.mp4', 'native-14.mp4 init-C.mp4', 'native-15.mp4 init-C.mp4']);
  assertMapPlacement(r, 'slid out');
});

test('TS playlists: stripAds and resequence never write a MAP', function () {
  ['all-ads.m3u8', 'clean.m3u8', 'ignored-only.m3u8', 'maf-ad.m3u8', 'midroll.m3u8', 'preroll.m3u8'].forEach(function (f) {
    var st = M.newSequenceState();
    st.passthrough = fixture('clean.m3u8');
    var t = M.stripAds(fixture(f), cfg).text;
    assert.notIncludes(t, '#EXT-X-MAP', f);
    assert.notIncludes(M.resequence(st, t, 'native', cfg.sequencer).text, '#EXT-X-MAP', f);
  });
});
