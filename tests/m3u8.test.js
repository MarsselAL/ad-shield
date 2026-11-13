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
