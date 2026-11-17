/* Backup-selection / strip state machine with an injected fake fetch (no network). */
loadSrc('src/config.js', 'src/core/m3u8.js', 'src/core/processor.js');
var cfg = __TAS__.config;
var M = __TAS__.m3u8;

var MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/somechannel.m3u8?allow_source=true&p=1&sig=S&token=T';
var MASTER = fixture('master.m3u8');
var PREROLL = fixture('preroll.m3u8');
var CLEAN = fixture('clean.m3u8');
var NATIVE_720 = 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-720p60.m3u8';

function backupMaster(type) { return MASTER.replace(/SYNTH-/g, 'SYNTH-' + type + '-'); }
function backupMedia720(type) { return 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-' + type + '-720p60.m3u8'; }
function cleanFor(type) { return CLEAN.replace(/SYNTH-live/g, 'SYNTH-' + type + '-live'); }

/**
 * Fake world. mediaByType: playerType -> media playlist text served for its 720p60 variant.
 * Options: tokenThrows {type: true}, now (function).
 */
function makeWorld(mediaByType, opts) {
  opts = opts || {};
  var w = { events: [], fetched: [], tokens: [], t: 1000000, settings: { playerTypes: cfg.backupPlayerTypes.slice(), preferAvc: true } };
  w.now = function () { return w.t; };
  w.deps = {
    cfg: cfg,
    m3u8: opts.m3u8 || M,
    getSettings: function () { return w.settings; },
    now: w.now,
    emit: function (name, data) { w.events.push({ name: name, data: data }); },
    degraded: opts.degraded || [],
    getToken: function (channel, type) {
      w.tokens.push(type);
      if (opts.tokenThrows && opts.tokenThrows[type]) return Promise.reject(new Error('token boom'));
      if (opts.noToken && opts.noToken[type]) return Promise.resolve(null);
      return Promise.resolve({ value: 'tok-' + type, signature: 'sig-' + type });
    },
    fetchText: function (url) {
      w.fetched.push(url);
      var m = /[?&]token=tok-([a-z_-]+)/.exec(url);
      if (url.indexOf('https://usher.ttvnw.net/') === 0 && m) {
        return Promise.resolve({ status: 200, text: backupMaster(m[1]) });
      }
      for (var type in mediaByType) {
        if (url === backupMedia720(type)) return Promise.resolve({ status: 200, text: mediaByType[type] });
      }
      return Promise.resolve({ status: 404, text: '' });
    }
  };
  w.proc = __TAS__.createProcessor(w.deps);
  w.names = function () { return w.events.map(function (e) { return e.name; }); };
  return w;
}

function segUrls(text) { return String(text).split('\n').filter(function (l) { return l && l.charAt(0) !== '#'; }); }
function tag(text, name) {
  var l = String(text).split('\n').filter(function (x) { return x.indexOf(name + ':') === 0; })[0];
  return l === undefined ? null : parseInt(l.slice(name.length + 1), 10);
}
/** Same segments in the same order, and the same first sequence number. */
function assertSameSegments(out, expected, msg) {
  assert.deepEqual(segUrls(out), segUrls(expected), msg || 'segments');
  assert.equal(tag(out, '#EXT-X-MEDIA-SEQUENCE'), tag(expected, '#EXT-X-MEDIA-SEQUENCE'), (msg || '') + ' media sequence');
}

function allTypes(text) {
  var o = {};
  cfg.backupPlayerTypes.forEach(function (t) { o[t] = text; });
  return o;
}

test('onMaster remembers variants and drops HEVC with preferAvc', function () {
  var w = makeWorld({});
  var out = w.proc.onMaster(MASTER_URL, MASTER);
  assert.notIncludes(out, 'hevc');
  assert.ok(w.proc.knowsMedia(NATIVE_720));
  assert.notOk(w.proc.knowsMedia('https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-1440p60-hevc.m3u8'));
});

test('onMaster ignores non-usher URLs', function () {
  var w = makeWorld({});
  assert.equal(w.proc.onMaster('https://example.invalid/x.m3u8', MASTER), MASTER);
  assert.notOk(w.proc.knowsMedia(NATIVE_720));
});

test('clean media playlist passes through untouched', function () {
  var w = makeWorld({});
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, CLEAN).then(function (out) {
    assert.equal(out, CLEAN);
    assert.equal(w.tokens.length, 0);
    assert.deepEqual(w.names(), []);
  });
});

test('ads in site, clean in popout: popout chosen (matching 720p60 variant) and pinned', function () {
  var w = makeWorld({ site: PREROLL, popout: cleanFor('popout'), mobile_web: cleanFor('mobile_web') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('popout'));
    assert.deepEqual(w.tokens, ['site', 'popout']);
    assert.ok(w.fetched.indexOf(backupMedia720('popout')) !== -1, 'fetched the 720p60 backup variant');
    assert.equal(w.proc.stateOf('somechannel').pinned, 'popout');
    var names = w.names();
    assert.deepEqual(names, ['ad-detected', 'ad-blocked-backup', 'playlist-switch']);
    assert.equal(w.events[1].data.playerType, 'popout');
    assert.equal(w.events[0].data.midroll, false);
    // backup usher URL carries the new token and keeps the original params
    var usher = w.fetched.filter(function (u) { return u.indexOf('tok-popout') !== -1; })[0];
    assert.includes(usher, 'allow_source=true');
    assert.includes(usher, 'sig=sig-popout');
    assert.notIncludes(usher, 'sig=S&');
  });
});

test('next poll tries the pinned type first and reuses the cached backup master', function () {
  var w = makeWorld({ site: PREROLL, popout: cleanFor('popout') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    w.t += 2000;
    w.fetched = [];
    w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function (out) {
    assertSameSegments(out, cleanFor('popout'));
    assert.deepEqual(w.tokens, [], 'no new token');
    assert.deepEqual(w.fetched, [backupMedia720('popout')], 'only the backup media playlist fetched');
    assert.equal(w.names().filter(function (n) { return n === 'ad-blocked-backup'; }).length, 1, 'counted once per break');
  });
});

test('break end: two clean native polls needed (debounce), then native again, ad-end and switch back', function () {
  var w = makeWorld({ site: PREROLL, popout: cleanFor('popout') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    return w.proc.onMedia(NATIVE_720, CLEAN);
  }).then(function (out) {
    assertSameSegments(out, cleanFor('popout'), 'first clean native poll: still the backup');
    assert.equal(w.names().indexOf('ad-end'), -1);
    return w.proc.onMedia(NATIVE_720, CLEAN);
  }).then(function (out) {
    var names = w.names();
    assert.deepEqual(names.slice(-2), ['ad-end', 'playlist-switch']);
    assert.equal(w.events[w.events.length - 1].data.to, 'native');
    assert.equal(w.events[w.events.length - 2].data.outcome, 'backup');
    assert.equal(w.events[w.events.length - 2].data.matched, true, 'backup matched native quality');
    // Native has the same live segments (same live numbers): nothing is listed twice and the
    // numbering continues where the backup left off.
    assert.equal(tag(out, '#EXT-X-MEDIA-SEQUENCE'), 5000);
    assert.equal(segUrls(out).filter(function (u) { return u.indexOf('SYNTH-live-') !== -1; }).length, 0, 'no repeated live segment');
  });
});

test('every backup has ads: ad segments stripped, ad segment URLs answered as ads', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.notOk(M.hasAds(out, cfg));
    assert.notIncludes(out, ',Amazon|');
    assert.notIncludes(out, '#EXT-X-TWITCH-PREFETCH');
    assert.includes(out, 'SYNTH-live-104.ts');
    assert.ok(w.tokens.length <= cfg.maxBackupTypesPerPoll);
    assert.deepEqual(w.names(), ['ad-detected', 'ad-stripped', 'playlist-switch']);
    assert.ok(w.proc.isAdSegment('https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-ad-100.ts'));
    assert.notOk(w.proc.isAdSegment('https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-104.ts'));
  });
});

test('types with ads are locked out briefly: next poll makes no token requests', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    w.t += 1000;
    w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function (out) {
    assert.deepEqual(w.tokens, []);
    assert.notOk(M.hasAds(out, cfg));
    w.t += cfg.playerTypeLockoutMs + 1;
    w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function () {
    assert.ok(w.tokens.length > 0, 'retried after the lockout');
  });
});

test('ad segment cache expires', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    w.t += cfg.adSegmentCacheTtlMs + 1;
    assert.notOk(w.proc.isAdSegment('https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-ad-100.ts'));
  });
});

test('stripping empties the playlist: newest known segments kept, numbering unchanged, stale last-clean not used', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, CLEAN).then(function (out) {
    assert.equal(out, CLEAN, 'untouched while clean');
    w.t += 2000;
    return w.proc.onMedia(NATIVE_720, fixture('all-ads.m3u8'));
  }).then(function (out) {
    assertSameSegments(out, CLEAN);
    w.t += cfg.lastCleanMaxAgeMs + 1;
    return w.proc.onMedia(NATIVE_720, fixture('all-ads.m3u8'));
  }).then(function (out) {
    assert.ok(cfg.lastCleanMaxAgeMs <= 6000);
    assert.equal(tag(out, '#EXT-X-MEDIA-SEQUENCE'), 5001, 'the newest three known segments, same numbers');
    assert.equal(M.countSegments(out), cfg.sequencer.minSegments);
    assert.notIncludes(out, 'SYNTH-ad-');
  });
});

test('token error for one type: locked out, next type used', function () {
  var w = makeWorld({ popout: cleanFor('popout') }, { tokenThrows: { site: true } });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('popout'));
    assert.ok(w.proc.stateOf('somechannel').lockouts.site > w.t);
  });
});

test('autoplay is used as last resort but never pinned', function () {
  var types = allTypes(PREROLL);
  types.autoplay = cleanFor('autoplay');
  var w = makeWorld(types);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('autoplay'));
    assert.equal(w.proc.stateOf('somechannel').pinned, null);
  });
});

test('degraded channel: no backup requests, strip only', function () {
  var w = makeWorld({ popout: cleanFor('popout') }, { degraded: ['SomeChannel'] });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.deepEqual(w.tokens, []);
    assert.notOk(M.hasAds(out, cfg));
    assert.equal(w.events[1].data.degraded, true);
  });
});

test('setDegraded at runtime switches the channel to strip-only', function () {
  var w = makeWorld({ popout: cleanFor('popout') });
  w.proc.onMaster(MASTER_URL, MASTER);
  w.proc.setDegraded('somechannel');
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    assert.deepEqual(w.tokens, []);
  });
});

test('client-side ad marker only (twitch-maf-ad) everywhere: reported as unremovable, live kept', function () {
  var w = makeWorld(allTypes(fixture('maf-ad.m3u8')));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, fixture('maf-ad.m3u8')).then(function (out) {
    assert.equal(M.countSegments(out), 2);
    assert.ok(w.names().indexOf('ad-unremovable') !== -1);
  });
});

test('internal exception: original playlist passed through untouched and failure reported', function () {
  var broken = Object.assign({}, M, { stripAds: function () { throw new Error('boom'); } });
  var w = makeWorld({ popout: cleanFor('popout') }, { m3u8: broken });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.equal(out, PREROLL);
    assert.ok(w.names().indexOf('failure') !== -1);
  });
});

test('exception in master parsing: master passed through untouched', function () {
  var broken = Object.assign({}, M, { parseMaster: function () { throw new Error('boom'); } });
  var w = makeWorld({}, { m3u8: broken });
  assert.equal(w.proc.onMaster(MASTER_URL, MASTER), MASTER);
  assert.ok(w.names().indexOf('failure') !== -1);
});

test('fetch rejecting for every backup: strip path, no exception escapes', function () {
  var w = makeWorld({});
  w.deps.fetchText = function () { return Promise.reject(new Error('network down')); };
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.notOk(M.hasAds(out, cfg));
  });
});

test('unknown media playlist: clean untouched, ads stripped', function () {
  var w = makeWorld({});
  return w.proc.onMedia('https://example.invalid/unknown.m3u8', CLEAN).then(function (out) {
    assert.equal(out, CLEAN);
    return w.proc.onMedia('https://example.invalid/unknown.m3u8', PREROLL);
  }).then(function (out) {
    assert.notOk(M.hasAds(out, cfg));
    assert.equal(w.tokens.length, 0);
  });
});

test('VOD: no backup tokens, strip only', function () {
  var w = makeWorld({ popout: cleanFor('popout') });
  w.proc.onMaster('https://usher.ttvnw.net/vod/123456.m3u8?sig=a&token=b', MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.deepEqual(w.tokens, []);
    assert.notOk(M.hasAds(out, cfg));
  });
});

test('custom playerType order from settings is respected', function () {
  var w = makeWorld({ embed: cleanFor('embed'), site: cleanFor('site') });
  w.settings.playerTypes = ['embed', 'site'];
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('embed'));
    assert.deepEqual(w.tokens, ['embed']);
  });
});

// ------------------------------------------------------------------ deadline, ordering, numbering
function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 12; i++) p = p.then(function () {});
  return p;
}
/** World whose popout media fetch waits for release(); timers are manual. */
function slowWorld(media) {
  var w = makeWorld(media || { popout: cleanFor('popout') });
  w.timers = [];
  w.deps.setTimeout = function (f, ms) { w.timers.push({ f: f, ms: ms }); return w.timers.length; };
  w.deps.clearTimeout = function (id) { w.timers[id - 1].cleared = true; };
  var gate = new Promise(function (r) { w.release = r; });
  var fast = w.deps.fetchText;
  w.deps.fetchText = function (url) {
    return url === backupMedia720('popout') ? gate.then(function () { return fast(url); }) : fast(url);
  };
  w.fireDeadline = function () {
    var t = w.timers.filter(function (x) { return !x.cleared && !x.fired; })[0];
    t.fired = true; t.f();
  };
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w;
}

test('per-poll deadline: slow backup -> stripped playlist on time; search continues once (single flight); next poll is one fetch', function () {
  var w = slowWorld();
  var p1 = w.proc.onMedia(NATIVE_720, PREROLL);
  var tokens;
  return flush().then(function () {
    assert.equal(w.timers[0].ms, cfg.backupPollDeadlineMs);
    assert.ok(cfg.backupPollDeadlineMs <= 2000);
    w.fireDeadline();
    return p1;
  }).then(function (out) {
    assert.notOk(M.hasAds(out, cfg));
    assert.includes(out, 'SYNTH-live-104.ts');
    assert.ok(w.names().indexOf('ad-stripped') !== -1);
    tokens = w.tokens.length;
    var p2 = w.proc.onMedia(NATIVE_720, PREROLL);
    return flush().then(function () {
      assert.equal(w.tokens.length, tokens, 'joined the search in flight, no new token requests');
      w.fireDeadline();
      return p2;
    });
  }).then(function () {
    w.release();
    return flush();
  }).then(function () {
    assert.equal(w.proc.stateOf('somechannel').pinned, 'popout', 'background search finished and pinned');
    w.fetched = []; w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function (out) {
    assert.deepEqual(w.tokens, []);
    assert.deepEqual(w.fetched, [backupMedia720('popout')], 'steady state: one fetch');
    assert.ok(segUrls(out).length > 0);
    assert.ok(w.names().indexOf('ad-blocked-backup') !== -1);
  });
});

test('answers leave in request order: a slow older poll is not overtaken by a fast newer one', function () {
  var w = slowWorld();
  w.deps.setTimeout = function () { return 0; }; // deadline never fires here
  w.deps.clearTimeout = function () { throw new Error('must not break the answer'); };
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  var order = [];
  var p1 = w.proc.onMedia(NATIVE_720, PREROLL).then(function (o) { order.push(1); return o; });
  var p2 = w.proc.onMedia(NATIVE_720, CLEAN).then(function (o) { order.push(2); return o; });
  return flush().then(function () {
    assert.deepEqual(order, [], 'the newer answer waits for the older one');
    w.release();
    return Promise.all([p1, p2]);
  }).then(function (outs) {
    assert.deepEqual(order, [1, 2]);
    assert.ok(tag(outs[1], '#EXT-X-MEDIA-SEQUENCE') >= tag(outs[0], '#EXT-X-MEDIA-SEQUENCE'));
  });
});

var SEGB = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/';
var T0 = Date.parse('2025-11-11T20:00:00.000Z');
function pl(o) {
  var lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:' + o.seq];
  if (o.live !== undefined) lines.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + o.live);
  if (o.ads) lines.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:00:00.000Z",DURATION=4.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"');
  if (o.map) lines.push('#EXT-X-MAP:URI="' + SEGB + 'init-' + o.map + '.mp4"'); // fMP4
  for (var i = o.from; i <= o.to; i++) {
    var ad = o.ads && o.ads.indexOf(i) !== -1;
    lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + i * 2000 + (o.skewMs || 0)).toISOString());
    lines.push('#EXTINF:2.000,' + (ad ? 'Amazon|1' : 'live'));
    lines.push(SEGB + (ad ? 'ad-' : o.prefix) + i + (o.map ? '.mp4' : '.ts'));
  }
  return lines.join('\n') + '\n';
}

test('switch native -> backup -> native: backup numbered by live sequence, DISCONTINUITY at each switch, no segment twice', function () {
  var backup = pl({ seq: 9000, live: 302, from: 302, to: 305, prefix: 'popout-' });
  var w = makeWorld({ popout: backup });
  w.settings.playerTypes = ['popout'];
  w.proc.onMaster(MASTER_URL, MASTER);
  var native1 = pl({ seq: 400, live: 300, from: 300, to: 303, prefix: 'native-' });
  var withAd = pl({ seq: 402, live: 302, from: 302, to: 305, prefix: 'native-', ads: [304, 305] });
  var back = pl({ seq: 410, live: 304, from: 304, to: 307, prefix: 'native-' });
  return w.proc.onMedia(NATIVE_720, native1).then(function (out) {
    assert.equal(out, native1, 'untouched before any ad');
    return w.proc.onMedia(NATIVE_720, withAd);
  }).then(function (out) {
    var p = M.parseMedia(out);
    assert.deepEqual(p.segs.map(function (s) { return s.url.replace(SEGB, ''); }), ['native-302.ts', 'native-303.ts', 'popout-304.ts', 'popout-305.ts']);
    assert.equal(p.mediaSeq, 402, 'page numbering kept, not the backup\'s 9000');
    assert.deepEqual(p.segs.map(function (s) { return s.disc; }), [false, false, true, false]);
    return w.proc.onMedia(NATIVE_720, back).then(function () { return w.proc.onMedia(NATIVE_720, back); });
  }).then(function (out) {
    var p = M.parseMedia(out);
    assert.deepEqual(p.segs.map(function (s) { return s.url.replace(SEGB, ''); }), ['popout-304.ts', 'popout-305.ts', 'native-306.ts', 'native-307.ts']);
    assert.equal(p.mediaSeq, 404, 'continuous although native came back 6 numbers ahead');
    assert.deepEqual(p.segs.map(function (s) { return s.disc; }), [false, false, true, false]);
    assert.equal(w.names().indexOf('segment-repeat'), -1);
  });
});

test('repeat detector: overlapping backup without live numbers -> one segment-repeat event', function () {
  var backup = pl({ seq: 70, from: 1, to: 5, prefix: 'popout-', skewMs: -1600 });
  var w = makeWorld({ popout: backup });
  w.settings.playerTypes = ['popout'];
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, pl({ seq: 0, from: 0, to: 3, prefix: 'native-' })).then(function () {
    return w.proc.onMedia(NATIVE_720, pl({ seq: 2, from: 2, to: 5, prefix: 'native-', ads: [4, 5] }));
  }).then(function () {
    assert.equal(w.names().filter(function (n) { return n === 'segment-repeat'; }).length, 1);
    w.t += 1000;
    return w.proc.onMedia(NATIVE_720, pl({ seq: 2, from: 2, to: 5, prefix: 'native-', ads: [4, 5] }));
  }).then(function () {
    assert.equal(w.names().filter(function (n) { return n === 'segment-repeat'; }).length, 1, 'once');
  });
});

test('backup served, one poll misses the deadline: hold (no new segments, no switch), then stripped after backupHoldMs', function () {
  var w = slowWorld();
  w.release();
  var first;
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    first = out;
    assert.equal(w.proc.stateOf('somechannel').serving, 'backup:popout');
    // From now on the backup hangs.
    w.deps.fetchText = function () { return new Promise(function () {}); };
    w.t += 1000;
    var p = w.proc.onMedia(NATIVE_720, PREROLL);
    return flush().then(function () { w.fireDeadline(); return p; });
  }).then(function (out) {
    assert.deepEqual(segUrls(out), segUrls(first), 'same segments as before');
    assert.equal(tag(out, '#EXT-X-MEDIA-SEQUENCE'), tag(first, '#EXT-X-MEDIA-SEQUENCE'));
    assert.equal(w.proc.stateOf('somechannel').serving, 'backup:popout', 'no switch');
    w.t += cfg.backupHoldMs;
    var p = w.proc.onMedia(NATIVE_720, PREROLL);
    return flush().then(function () { w.fireDeadline(); return p; });
  }).then(function (out) {
    assert.equal(w.proc.stateOf('somechannel').serving, 'stripped');
    assert.notIncludes(out, 'SYNTH-ad-');
  });
});

/** For each listed segment (short name): the init segment (MAP) the player would use for it. */
function segMaps(text) {
  var cur = null, res = [];
  String(text).split('\n').forEach(function (l) {
    if (l.indexOf('#EXT-X-MAP:') === 0) cur = /URI="([^"]*)"/.exec(l)[1].replace(SEGB, '').replace(/^https:\/\/[^/]+\//, '');
    else if (l && l[0] !== '#') res.push(l.replace(SEGB, '') + ' ' + cur);
  });
  return res;
}

// twitch.tv/lirik 2026-11-17: fMP4 channel, first load gets a 100% pre-roll, a backup is served,
// then native returns. Each source's segments must be listed under that source's own init
// segment, or the video does not decode (offline image with sound).
test('fMP4 first load: 100% pre-roll -> backup under its own MAP -> native under its own MAP', function () {
  var backup = pl({ seq: 9000, live: 302, from: 302, to: 305, prefix: 'embed-', map: 'B' });
  var w = makeWorld({ embed: backup });
  w.settings.playerTypes = ['embed'];
  w.proc.onMaster(MASTER_URL, MASTER);
  var preroll = fixture('fmp4-preroll.m3u8');
  var back = pl({ seq: 0, live: 304, from: 304, to: 307, prefix: 'native-', map: 'A' });
  return w.proc.onMedia(NATIVE_720, preroll).then(function (out) {
    assert.notIncludes(out, 'SYNTH-ad');
    assert.deepEqual(segMaps(out), ['embed-302.mp4 init-B.mp4', 'embed-303.mp4 init-B.mp4', 'embed-304.mp4 init-B.mp4', 'embed-305.mp4 init-B.mp4']);
    var head = out.split('\n');
    assert.equal(head.findIndex(function (l) { return l.indexOf('#EXT-X-MAP') === 0; }) + 1,
      head.findIndex(function (l) { return l.indexOf('#EXT-X-PROGRAM-DATE-TIME') === 0; }), 'backup MAP directly before its first segment');
    return w.proc.onMedia(NATIVE_720, back).then(function () { return w.proc.onMedia(NATIVE_720, back); });
  }).then(function (out) {
    assert.deepEqual(segMaps(out), ['embed-304.mp4 init-B.mp4', 'embed-305.mp4 init-B.mp4', 'native-306.mp4 init-A.mp4', 'native-307.mp4 init-A.mp4']);
    var p = M.parseMedia(out);
    assert.deepEqual(p.segs.map(function (s) { return s.disc; }), [false, false, true, false]);
    assert.equal(w.proc.stateOf('somechannel').serving, 'native');
  });
});
