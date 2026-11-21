/* Backup-selection / strip state machine with an injected fake fetch (no network). */
loadSrc('src/config.js', 'src/core/m3u8.js', 'src/core/processor.js');
var cfg = __TAS__.config;
var M = __TAS__.m3u8;

var MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/somechannel.m3u8?allow_source=true&p=1&sig=S&token=T';
var MASTER = fixture('master.m3u8');
var PREROLL = fixture('preroll.m3u8');
var CLEAN = fixture('clean.m3u8');
var NATIVE_720 = 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-720p60.m3u8';
// PREROLL keeps 2 live segments, fewer than sequencer.minSegments: on a first poll that is too
// thin to serve stripped. PREROLL3 keeps 3 (the strip path).
var SEG106 = 'https://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-live-106.ts';
var PREROLL3 = PREROLL.replace('#EXT-X-TWITCH-PREFETCH:' + SEG106 + '\n',
  '#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:12.008Z\n#EXTINF:2.000,live\n' + SEG106 + '\n');

function backupMaster(type) { return MASTER.replace(/SYNTH-/g, 'SYNTH-' + type + '-'); }
/** A backup master without the 720p60 variant the player chose (other resolutions only). */
function masterWithout720(type) {
  return backupMaster(type).split('\n').filter(function (l) { return l.indexOf('720p60') === -1 && l.indexOf('1280x720') === -1; }).join('\n');
}
function backupMedia720(type) { return 'https://video-weaver.xyz01.hls.ttvnw.net/v1/playlist/SYNTH-' + type + '-720p60.m3u8'; }
function cleanFor(type) { return CLEAN.replace(/SYNTH-live/g, 'SYNTH-' + type + '-live'); }

/**
 * Fake world. mediaByType: playerType -> media playlist text served for its 720p60 variant.
 * Options: tokenThrows {type: true}, noToken {type: true}, masters {type: master text}.
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
        var mt = opts.masters && opts.masters[m[1]];
        return Promise.resolve({ status: 200, text: mt || backupMaster(m[1]) });
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
    assert.deepEqual(w.tokens, ['embed'], 'only the master prewarm');
    assert.equal(w.fetched.length, 1, 'only the prewarmed backup master');
    assert.deepEqual(w.names(), []);
  });
});

test('default backup order is embed, site, mobile_web, popout: no autoplay (360p), popout skipped (page token type)', function () {
  assert.deepEqual(cfg.backupPlayerTypes, ['embed', 'site', 'mobile_web', 'popout']);
  assert.equal(cfg.forcedPlayerType, 'popout');
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    assert.deepEqual(w.tokens, ['embed', 'site', 'mobile_web']);
    assert.equal(w.tokens.indexOf('autoplay'), -1, 'autoplay never requested');
  });
});

test('ads in embed, clean in site: site chosen (matching 720p60 variant) and pinned', function () {
  var w = makeWorld({ embed: PREROLL, site: cleanFor('site'), mobile_web: cleanFor('mobile_web') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('site'));
    assert.deepEqual(w.tokens, ['embed', 'site', 'mobile_web'], 'all asked at once (embed prewarmed with the master)');
    assert.ok(w.fetched.indexOf(backupMedia720('site')) !== -1, 'fetched the 720p60 backup variant');
    assert.equal(w.proc.stateOf('somechannel').pinned, 'site');
    var names = w.names();
    assert.deepEqual(names, ['ad-detected', 'ad-blocked-backup', 'playlist-switch']);
    assert.equal(w.events[1].data.playerType, 'site');
    assert.equal(w.events[1].data.resolution, '1280x720');
    assert.equal(w.events[0].data.midroll, false);
    // backup usher URL carries the new token and keeps the original params
    var usher = w.fetched.filter(function (u) { return u.indexOf('tok-site') !== -1; })[0];
    assert.includes(usher, 'allow_source=true');
    assert.includes(usher, 'sig=sig-site');
    assert.notIncludes(usher, 'sig=S&');
  });
});

test('backup without the chosen resolution is skipped for this poll (no lockout), next type used', function () {
  var w = makeWorld({ embed: cleanFor('embed'), site: cleanFor('site') }, { masters: { embed: masterWithout720('embed') } });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('site'));
    assert.deepEqual(w.tokens, ['embed', 'site', 'mobile_web']);
    assert.equal(w.fetched.filter(function (u) { return u.indexOf('SYNTH-embed-') !== -1 && u.indexOf('usher') === -1; }).length, 0,
      'no other embed variant fetched');
    assert.notOk((w.proc.stateOf('somechannel').lockouts.embed || 0) > w.t, 'embed not locked out');
  });
});

test('no backup at the chosen resolution: stripped native served, never a lower-quality backup', function () {
  var masters = {};
  cfg.backupPlayerTypes.forEach(function (t) { masters[t] = masterWithout720(t); });
  var w = makeWorld({}, { masters: masters });
  // Every type would be clean at other resolutions.
  w.deps.fetchText = (function (inner) {
    return function (url) {
      if (url.indexOf('usher') === -1 && /SYNTH-[a-z_]+-(480p30|360p30|chunked)/.test(url)) {
        w.fetched.push(url);
        return Promise.resolve({ status: 200, text: CLEAN });
      }
      return inner(url);
    };
  })(w.deps.fetchText);
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL3).then(function (out) {
    assert.notOk(M.hasAds(out, cfg));
    assert.includes(out, 'SYNTH-live-104.ts');
    assert.notIncludes(out, 'SYNTH-embed-');
    assert.deepEqual(w.names(), ['ad-detected', 'ad-stripped', 'playlist-switch']);
    assert.equal(w.events[2].data.to, 'stripped');
    w.tokens = []; w.fetched = [];
    w.t += 2000;
    return w.proc.onMedia(NATIVE_720, PREROLL3);
  }).then(function (out) {
    assert.deepEqual(w.tokens, [], 'cached masters: no new token requests');
    assert.deepEqual(w.fetched, [], 'still nothing at 720p60: no backup media fetched');
    assert.notOk(M.hasAds(out, cfg));
  });
});

test('next poll tries the pinned type first and reuses the cached backup master', function () {
  var w = makeWorld({ popout: PREROLL, embed: cleanFor('embed') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    w.t += 2000;
    w.fetched = [];
    w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'));
    assert.deepEqual(w.tokens, [], 'no new token');
    assert.deepEqual(w.fetched, [backupMedia720('embed')], 'only the backup media playlist fetched');
    assert.equal(w.names().filter(function (n) { return n === 'ad-blocked-backup'; }).length, 1, 'counted once per break');
  });
});

test('break end: two clean native polls needed (debounce), then native again, ad-end and switch back', function () {
  var w = makeWorld({ embed: cleanFor('embed') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    return w.proc.onMedia(NATIVE_720, CLEAN);
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'), 'first clean native poll: still the backup');
    assert.equal(w.names().indexOf('ad-end'), -1);
    return w.proc.onMedia(NATIVE_720, CLEAN);
  }).then(function (out) {
    var names = w.names();
    assert.deepEqual(names.slice(-2), ['ad-end', 'playlist-switch']);
    assert.equal(w.events[w.events.length - 1].data.to, 'native');
    assert.equal(w.events[w.events.length - 2].data.outcome, 'backup');
    // Native has the same live segments (same live numbers): nothing is listed twice and the
    // numbering continues where the backup left off.
    assert.equal(tag(out, '#EXT-X-MEDIA-SEQUENCE'), 5000);
    assert.equal(segUrls(out).filter(function (u) { return u.indexOf('SYNTH-live-') !== -1; }).length, 0, 'no repeated live segment');
  });
});

test('every backup has ads: ad segments stripped, ad segment URLs answered as ads', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL3).then(function (out) {
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
    // (The window may re-list a segment the player already got in the passed-through first poll.)
    assert.notIncludes(out, 'twitch-stitched-ad');
    assert.notIncludes(out, ',Amazon|');
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

test('stripping empties the playlist, no clean backup: original playlist (the ad plays), no last-clean replay', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, CLEAN).then(function (out) {
    assert.equal(out, CLEAN, 'untouched while clean');
    w.t += 2000;
    return w.proc.onMedia(NATIVE_720, fixture('all-ads.m3u8'));
  }).then(function (out) {
    assert.ok(out !== CLEAN, 'the last clean playlist is not replayed');
    assert.equal(out, fixture('all-ads.m3u8'), 'never an empty playlist');
    assert.ok(w.names().indexOf('ad-passthrough') !== -1);
    assert.equal(cfg.lastCleanMaxAgeMs, undefined);
    assert.equal(cfg.backupHoldMs, undefined);
  });
});

test('token error for one type: locked out, next type used', function () {
  var w = makeWorld({ site: cleanFor('site') }, { tokenThrows: { embed: true } });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assertSameSegments(out, cleanFor('site'));
    assert.ok(w.proc.stateOf('somechannel').lockouts.embed > w.t);
  });
});

// Purple T-204 / B-012: a backup that announces its own break is contaminated even while all its
// segments are still live: locked out (playerTypeLockoutMs), master dropped, next type used.
function announcing(type, line) {
  return cleanFor(type).replace('#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:00.000Z', line + '\n#EXT-X-PROGRAM-DATE-TIME:2025-11-11T20:00:00.000Z');
}
[
  ['stitched-ad DATERANGE with a future START-DATE', '#EXT-X-DATERANGE:ID="stitched-ad-1762891260-30",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:01:00.000Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-POD-LENGTH="1"'],
  ['EXT-X-CUE-OUT', '#EXT-X-CUE-OUT:30.000'],
  ['an ad-titled segment', '#EXTINF:2.002,FT|1-2-3\nhttps://video-edge-000000.xyz01.abs.hls.ttvnw.net/v1/segment/SYNTH-embed-ad-1.ts']
].forEach(function (c) {
  test('backup announcing its own break (' + c[0] + '): contaminated, locked out, next type used', function () {
    var w = makeWorld({ embed: announcing('embed', c[1]), site: cleanFor('site'), mobile_web: cleanFor('mobile_web') });
    assert.ok(M.hasAds(announcing('embed', c[1]), cfg), 'hasAds on the backup');
    w.proc.onMaster(MASTER_URL, MASTER);
    return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
      assertSameSegments(out, cleanFor('site'));
      assert.ok(w.proc.stateOf('somechannel').lockouts.embed > w.t, 'embed locked out');
      assert.equal(w.proc.stateOf('somechannel').pinned, 'site');
    });
  });
});

// TTV-AB #98: a client-side ad (twitch-maf-ad) is a separate video beside the stream; the
// playlist's segments are all live. Nothing to replace: no backup search, no stripping.
test('client-side ad marker only (twitch-maf-ad), all segments live: untouched, no backup search, no events', function () {
  var maf = fixture('maf-ad.m3u8');
  var w = makeWorld(allTypes(cleanFor('x')));
  w.proc.onMaster(MASTER_URL, MASTER);
  var tokens = w.tokens.slice();
  return w.proc.onMedia(NATIVE_720, maf).then(function (out) {
    assert.equal(out, maf, 'byte for byte');
    return w.proc.onMedia(NATIVE_720, maf);
  }).then(function (out) {
    assert.equal(out, maf);
    assert.deepEqual(w.tokens, tokens, 'no token beyond the master prewarm');
    assert.equal(w.fetched.filter(function (u) { return u.indexOf('https://usher.ttvnw.net/') !== 0; }).length, 0, 'no backup media fetch');
    assert.ok(w.fetched.length <= 1, 'at most the prewarmed master');
    assert.deepEqual(w.names(), []);
    assert.equal(w.proc.stateOf('somechannel').serving, 'native');
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
  return w.proc.onMedia(NATIVE_720, PREROLL3).then(function (out) {
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
    assert.deepEqual(w.tokens, ['embed', 'site']);
    assert.equal(w.proc.stateOf('somechannel').pinned, 'embed');
  });
});

// ------------------------------------------------------------------ deadline, ordering, numbering
function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 12; i++) p = p.then(function () {});
  return p;
}
/** World whose embed media fetch waits for release(); timers are manual. */
function slowWorld(media) {
  var w = makeWorld(media || { embed: cleanFor('embed') });
  w.timers = [];
  w.deps.setTimeout = function (f, ms) { w.timers.push({ f: f, ms: ms }); return w.timers.length; };
  w.deps.clearTimeout = function (id) { w.timers[id - 1].cleared = true; };
  var gate = new Promise(function (r) { w.release = r; });
  var fast = w.deps.fetchText;
  w.deps.fetchText = function (url) {
    return url === backupMedia720('embed') ? gate.then(function () { return fast(url); }) : fast(url);
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
  var p1 = w.proc.onMedia(NATIVE_720, PREROLL3);
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
    var p2 = w.proc.onMedia(NATIVE_720, PREROLL3);
    return flush().then(function () {
      assert.equal(w.tokens.length, tokens, 'joined the search in flight, no new token requests');
      w.fireDeadline();
      return p2;
    });
  }).then(function () {
    w.release();
    return flush();
  }).then(function () {
    assert.equal(w.proc.stateOf('somechannel').pinned, 'embed', 'background search finished and pinned');
    w.fetched = []; w.tokens = [];
    return w.proc.onMedia(NATIVE_720, PREROLL3);
  }).then(function (out) {
    assert.deepEqual(w.tokens, []);
    assert.deepEqual(w.fetched, [backupMedia720('embed')], 'steady state: one fetch');
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
  var backup = pl({ seq: 9000, live: 302, from: 302, to: 305, prefix: 'embed-' });
  var w = makeWorld({ embed: backup });
  w.settings.playerTypes = ['embed'];
  w.proc.onMaster(MASTER_URL, MASTER);
  var native1 = pl({ seq: 400, live: 300, from: 300, to: 303, prefix: 'native-' });
  var withAd = pl({ seq: 402, live: 302, from: 302, to: 305, prefix: 'native-', ads: [304, 305] });
  var back = pl({ seq: 410, live: 304, from: 304, to: 307, prefix: 'native-' });
  return w.proc.onMedia(NATIVE_720, native1).then(function (out) {
    assert.equal(out, native1, 'untouched before any ad');
    return w.proc.onMedia(NATIVE_720, withAd);
  }).then(function (out) {
    var p = M.parseMedia(out);
    assert.deepEqual(p.segs.map(function (s) { return s.url.replace(SEGB, ''); }), ['native-302.ts', 'native-303.ts', 'embed-304.ts', 'embed-305.ts']);
    assert.equal(p.mediaSeq, 402, 'page numbering kept, not the backup\'s 9000');
    assert.deepEqual(p.segs.map(function (s) { return s.disc; }), [false, false, true, false]);
    return w.proc.onMedia(NATIVE_720, back).then(function () { return w.proc.onMedia(NATIVE_720, back); });
  }).then(function (out) {
    var p = M.parseMedia(out);
    assert.deepEqual(p.segs.map(function (s) { return s.url.replace(SEGB, ''); }), ['embed-304.ts', 'embed-305.ts', 'native-306.ts', 'native-307.ts']);
    assert.equal(p.mediaSeq, 404, 'continuous although native came back 6 numbers ahead');
    assert.deepEqual(p.segs.map(function (s) { return s.disc; }), [false, false, true, false]);
    assert.equal(w.names().indexOf('segment-repeat'), -1);
  });
});

test('repeat detector: overlapping backup without live numbers -> one segment-repeat event', function () {
  var backup = pl({ seq: 70, from: 1, to: 5, prefix: 'embed-', skewMs: -1600 });
  var w = makeWorld({ embed: backup });
  w.settings.playerTypes = ['embed'];
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

test('backup served, one poll misses the deadline: stripped native served at once (no hold, no replay)', function () {
  var w = slowWorld();
  w.release();
  var first;
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    first = out;
    assert.equal(w.proc.stateOf('somechannel').serving, 'backup:embed');
    // From now on the backup hangs.
    w.deps.fetchText = function () { return new Promise(function () {}); };
    w.t += 1000;
    var p = w.proc.onMedia(NATIVE_720, PREROLL);
    return flush().then(function () { w.fireDeadline(); return p; });
  }).then(function (out) {
    assert.equal(w.proc.stateOf('somechannel').serving, 'stripped');
    assert.notIncludes(out, 'SYNTH-ad-');
    assert.ok(tag(out, '#EXT-X-MEDIA-SEQUENCE') >= tag(first, '#EXT-X-MEDIA-SEQUENCE'), 'numbering never goes back');
    assert.ok(M.countSegments(out) >= cfg.sequencer.minSegments);
    assert.equal(w.events[w.events.length - 1].name, 'playlist-switch');
    assert.equal(w.events[w.events.length - 1].data.to, 'stripped');
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

// twitch.tv/kaicenat 2026-11-19, fresh load into a pre-roll: the page token is rewritten to
// popout, so native = popout = ad-only (3 ad segments, 0 live); embed is clean at the same
// resolution. Stripping native leaves nothing: the poll must wait for the backup search (no poll
// deadline), never serve an empty playlist, and never ask for popout (same as native).
function adOnly(prefix) { return pl({ seq: 100, live: 500, from: 500, to: 502, prefix: prefix, ads: [500, 501, 502] }); }

test('kaicenat: native and popout ad-only, embed clean but slow: waits past the deadline, serves embed, popout never requested', function () {
  var embed = pl({ seq: 9000, live: 490, from: 490, to: 504, prefix: 'embed-' });
  var w = makeWorld({ popout: adOnly('popout-'), embed: embed, site: adOnly('site-'), mobile_web: adOnly('mobile_web-') });
  w.settings.playerTypes = ['popout', 'embed', 'site', 'mobile_web']; // even when listed first
  w.timers = [];
  w.deps.setTimeout = function (f, ms) { w.timers.push({ f: f, ms: ms }); return w.timers.length; };
  w.deps.clearTimeout = function () {};
  var gate = new Promise(function (r) { w.release = r; });
  var fast = w.deps.fetchText;
  w.deps.fetchText = function (url) {
    return url === backupMedia720('embed') ? gate.then(function () { return fast(url); }) : fast(url);
  };
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  var settled = false;
  var p = w.proc.onMedia(NATIVE_720, adOnly('native-')).then(function (o) { settled = true; return o; });
  return flush().then(function () {
    w.timers.forEach(function (t) { t.f(); }); // any poll deadline passes
    return flush();
  }).then(function () {
    assert.notOk(settled, 'no answer before the search ends (an empty stripped playlist is never served)');
    w.release();
    return p;
  }).then(function (out) {
    assert.equal(M.countSegments(out), 15, 'embed\'s playlist, not an empty one');
    assert.equal(segUrls(out)[0], SEGB + 'embed-490.ts');
    assert.notIncludes(out, SEGB + 'ad-');
    assert.equal(w.tokens.indexOf('popout'), -1, 'popout never requested');
    assert.equal(w.fetched.filter(function (u) { return u.indexOf('popout') !== -1; }).length, 0);
    assert.equal(w.proc.stateOf('somechannel').serving, 'backup:embed');
    assert.ok(w.names().indexOf('ad-blocked-backup') !== -1);
  });
});

test('kaicenat: every backup ad-only too: original playlist unmodified (the ad plays), never an empty one', function () {
  var native = adOnly('native-');
  var w = makeWorld({ popout: adOnly('popout-'), embed: adOnly('embed-'), site: adOnly('site-'), mobile_web: adOnly('mobile_web-') });
  w.deps.setTimeout = function (f) { f(); return 1; }; // the poll deadline is already over
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, native).then(function (out) {
    assert.equal(out, native, 'original, byte for byte');
    assert.equal(w.tokens.indexOf('popout'), -1, 'popout never requested');
    assert.ok(w.tokens.length > 0, 'the backups were tried');
    assert.ok(w.names().indexOf('ad-passthrough') !== -1, 'reported');
    assert.equal(w.names().indexOf('ad-stripped'), -1);
    assert.notOk(w.proc.isAdSegment(SEGB + 'ad-500.ts'), 'the ad segments are not blanked: the ad plays');
  });
});

test('first poll keeps fewer live segments than minSegments: no poll deadline either', function () {
  var w = slowWorld({ embed: cleanFor('embed') });
  var settled = false;
  var p = w.proc.onMedia(NATIVE_720, PREROLL).then(function (o) { settled = true; return o; }); // 2 live
  return flush().then(function () {
    w.timers.forEach(function (t) { t.f(); });
    return flush();
  }).then(function () {
    assert.notOk(settled);
    w.release();
    return p;
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'));
  });
});

// ------------------------------------------------------------------ stitched preroll live numbers
/**
 * Twitch stitched preroll as captured live (kaicenat, 2026-11-19): `ads` ad segments, then
 * DISCONTINUITY and the live segments `from`..`to`. #EXT-X-TWITCH-LIVE-SEQUENCE (o.live, only
 * once live segments are listed) is the number of the FIRST LIVE segment, not of the first one.
 */
function preroll(o) {
  var lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:' + o.seq];
  if (o.live !== undefined) lines.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + o.live);
  lines.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2025-11-11T20:00:00.000Z",DURATION=16.000,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"');
  for (var a = o.firstAd || 0; a < o.ads; a++) {
    if (a === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + a * 2000).toISOString());
    lines.push('#EXTINF:2.000,Amazon|248888310');
    lines.push(SEGB + 'preroll-ad-' + a + '.ts');
  }
  for (var i = o.from; o.to !== undefined && i <= o.to; i++) {
    if (i === o.from) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(T0 + o.ads * 2000 + (i - o.from) * 2000).toISOString());
    lines.push('#EXTINF:2.000,live');
    lines.push(SEGB + 'live-' + i + '.ts');
  }
  return lines.join('\n') + '\n';
}

test('stitched preroll passed through, then live segments appear: the live segments are served, not dropped', function () {
  var w = makeWorld(allTypes(adOnly('backup-')));
  w.deps.setTimeout = function (f) { f(); return 1; }; // the poll deadline is already over
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  var poll1 = preroll({ seq: 0, ads: 8 });
  var poll2 = preroll({ seq: 0, live: 58602, ads: 8, from: 58602, to: 58603 });
  var poll3 = preroll({ seq: 2, live: 58602, firstAd: 2, ads: 8, from: 58602, to: 58605 });
  var seq2;
  return w.proc.onMedia(NATIVE_720, poll1).then(function (out) {
    assert.equal(out, poll1, 'ad-only preroll, no clean backup: original');
    assert.ok(w.names().indexOf('ad-passthrough') !== -1);
    return w.proc.onMedia(NATIVE_720, poll2);
  }).then(function (out) {
    assert.includes(out, SEGB + 'live-58602.ts', 'first live segment served');
    assert.includes(out, SEGB + 'live-58603.ts', 'second live segment served');
    seq2 = tag(out, '#EXT-X-MEDIA-SEQUENCE');
    return w.proc.onMedia(NATIVE_720, poll3);
  }).then(function (out) {
    var urls = segUrls(out);
    assert.equal(urls[urls.length - 1], SEGB + 'live-58605.ts', 'newest live segment appended');
    assert.includes(out, SEGB + 'live-58604.ts');
    assert.equal(urls.filter(function (u) { return u === SEGB + 'live-58602.ts'; }).length <= 1, true, 'no segment twice');
    assert.ok(tag(out, '#EXT-X-MEDIA-SEQUENCE') >= seq2, 'MEDIA-SEQUENCE monotonic');
  });
});

test('stitched preroll with live segments passed through on the first poll: next polls still serve the live segments', function () {
  var w = makeWorld(allTypes(adOnly('backup-')));
  w.deps.setTimeout = function (f) { f(); return 1; };
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  var poll1 = preroll({ seq: 0, live: 58602, ads: 8, from: 58602, to: 58603 }); // 2 live < minSegments: thin
  var poll2 = preroll({ seq: 2, live: 58602, firstAd: 2, ads: 8, from: 58602, to: 58605 });
  var poll3 = preroll({ seq: 4, live: 58602, firstAd: 4, ads: 8, from: 58602, to: 58607 });
  var seq2;
  return w.proc.onMedia(NATIVE_720, poll1).then(function (out) {
    assert.equal(out, poll1, 'first poll too thin to strip, no clean backup: original');
    return w.proc.onMedia(NATIVE_720, poll2);
  }).then(function (out) {
    assert.includes(out, SEGB + 'live-58604.ts', 'new live segment served');
    assert.includes(out, SEGB + 'live-58605.ts', 'new live segment served');
    seq2 = tag(out, '#EXT-X-MEDIA-SEQUENCE');
    return w.proc.onMedia(NATIVE_720, poll3);
  }).then(function (out) {
    var urls = segUrls(out);
    assert.equal(urls[urls.length - 1], SEGB + 'live-58607.ts', 'newest live segment appended');
    assert.includes(out, SEGB + 'live-58606.ts');
    assert.ok(tag(out, '#EXT-X-MEDIA-SEQUENCE') >= seq2, 'MEDIA-SEQUENCE monotonic');
  });
});

// ------------------------------------------------------------------ join-time prewarm, parallel search
// Purple ec29b68 / d9cafb2: prewarm the first backup type's token + master when the live master is
// seen; on an ad poll ask every candidate type at once and take the most preferred clean answer.

test('prewarm: live master answered at once (token pending), first backup type asked once per channel per TTL', function () {
  var w = makeWorld({});
  var pending = [];
  w.deps.getToken = function (ch, type) { w.tokens.push(type); return new Promise(function (r) { pending.push(r); }); };
  w.settings.playerTypes = ['popout', 'site', 'embed']; // popout = the page token type: skipped
  w.proc = __TAS__.createProcessor(w.deps);
  var out = w.proc.onMaster(MASTER_URL, MASTER);
  assert.equal(typeof out, 'string', 'synchronous answer');
  assert.ok(w.proc.knowsMedia(NATIVE_720));
  assert.deepEqual(w.tokens, ['site']);
  w.t += 1000;
  w.proc.onMaster(MASTER_URL, MASTER);
  assert.deepEqual(w.tokens, ['site'], 'no second prewarm within backupMasterTtlMs');
  pending.forEach(function (r) { r(null); });
  return flush().then(function () {
    w.t += cfg.backupMasterTtlMs;
    w.proc.onMaster(MASTER_URL, MASTER);
    assert.deepEqual(w.tokens, ['site', 'site'], 'again after the TTL');
  });
});

test('prewarm: none for VOD masters or with no backup types', function () {
  var w = makeWorld({});
  w.proc.onMaster('https://usher.ttvnw.net/vod/123456.m3u8?sig=a&token=b', MASTER);
  assert.deepEqual(w.tokens, []);
  w.settings.playerTypes = [];
  w.proc.onMaster(MASTER_URL, MASTER);
  assert.deepEqual(w.tokens, []);
});

test('prewarm: the ad poll reuses the prewarmed master (done or still in flight): one embed token, one embed master', function () {
  function embedUshers(w) { return w.fetched.filter(function (u) { return u.indexOf('tok-embed') !== -1; }).length; }
  var w1 = makeWorld({ embed: cleanFor('embed') });
  w1.proc.onMaster(MASTER_URL, MASTER);
  return flush().then(function () {
    assert.equal(embedUshers(w1), 1, 'prewarm finished');
    return w1.proc.onMedia(NATIVE_720, PREROLL);
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'));
    assert.equal(w1.tokens.filter(function (t) { return t === 'embed'; }).length, 1);
    assert.equal(embedUshers(w1), 1);
    var w2 = makeWorld({ embed: cleanFor('embed') });
    w2.proc.onMaster(MASTER_URL, MASTER);
    return w2.proc.onMedia(NATIVE_720, PREROLL).then(function (out2) { // prewarm still in flight
      assertSameSegments(out2, cleanFor('embed'));
      assert.equal(w2.tokens.filter(function (t) { return t === 'embed'; }).length, 1);
      assert.equal(embedUshers(w2), 1);
    });
  });
});

/** World whose backup media fetches each wait for release(type). */
function gatedWorld(media) {
  var w = makeWorld(media);
  var gates = {};
  w.release = function (type) { gates[type].open(); };
  cfg.backupPlayerTypes.forEach(function (t) {
    var g = {}; g.p = new Promise(function (r) { g.open = r; }); gates[t] = g;
  });
  var fast = w.deps.fetchText;
  w.asked = [];
  w.deps.fetchText = function (url) {
    w.asked.push(url);
    var m = /SYNTH-([a-z_]+)-720p60\.m3u8$/.exec(url);
    return m && gates[m[1]] ? gates[m[1]].p.then(function () { return fast(url); }) : fast(url);
  };
  w.deps.setTimeout = function () { return 0; }; // the poll deadline never fires here
  w.deps.clearTimeout = function () {};
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w;
}

test('parallel: every candidate type is asked before any answers (popout skipped)', function () {
  var w = gatedWorld({ embed: cleanFor('embed'), site: cleanFor('site'), mobile_web: cleanFor('mobile_web') });
  var p = w.proc.onMedia(NATIVE_720, PREROLL3);
  return flush().then(function () {
    assert.deepEqual(w.tokens, ['embed', 'site', 'mobile_web']);
    ['embed', 'site', 'mobile_web'].forEach(function (t) {
      assert.ok(w.asked.indexOf(backupMedia720(t)) !== -1, t + ' media requested');
    });
    assert.equal(w.asked.filter(function (u) { return u.indexOf('popout') !== -1; }).length, 0);
    w.release('embed'); w.release('site'); w.release('mobile_web');
    return p;
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'), 'all clean: the preferred type');
    assert.equal(w.proc.stateOf('somechannel').pinned, 'embed');
  });
});

test('parallel: a clean less-preferred type is served without waiting for a slower preferred one', function () {
  var w = gatedWorld({ embed: cleanFor('embed'), site: cleanFor('site'), mobile_web: PREROLL });
  var p = w.proc.onMedia(NATIVE_720, PREROLL3);
  return flush().then(function () {
    w.release('mobile_web');
    w.release('site');
    return p; // embed still pending, no deadline timer fires
  }).then(function (out) {
    assertSameSegments(out, cleanFor('site'));
    assert.equal(w.proc.stateOf('somechannel').serving, 'backup:site');
    assert.equal(w.proc.stateOf('somechannel').pinned, 'site');
    assert.ok(w.proc.stateOf('somechannel').lockouts.mobile_web > w.t, 'type with ads locked out');
    w.release('embed');
    return flush();
  }).then(function () {
    assert.equal(w.proc.stateOf('somechannel').pinned, 'site', 'a late clean answer does not change the pin');
  });
});

test('parallel: the preferred type wins when its clean answer is known with the others', function () {
  var w = gatedWorld({ embed: cleanFor('embed'), site: cleanFor('site'), mobile_web: cleanFor('mobile_web') });
  var p = w.proc.onMedia(NATIVE_720, PREROLL3);
  return flush().then(function () {
    w.release('site'); w.release('embed'); // same turn
    return p;
  }).then(function (out) {
    assertSameSegments(out, cleanFor('embed'));
  });
});

test('parallel: one search per channel; a poll during it starts no new requests', function () {
  var w = gatedWorld({ embed: cleanFor('embed'), site: cleanFor('site'), mobile_web: cleanFor('mobile_web') });
  var p1 = w.proc.onMedia(NATIVE_720, PREROLL3);
  var tokens, fetched;
  return flush().then(function () {
    tokens = w.tokens.length; fetched = w.asked.length;
    var p2 = w.proc.onMedia(NATIVE_720, PREROLL3);
    return flush().then(function () {
      assert.equal(w.tokens.length, tokens);
      assert.equal(w.asked.length, fetched);
      w.release('embed'); w.release('site'); w.release('mobile_web');
      return Promise.all([p1, p2]);
    });
  }).then(function (outs) {
    assertSameSegments(outs[0], cleanFor('embed'));
  });
});

test('parallel: at most maxBackupTypesPerPoll types asked', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.deps.cfg = Object.assign({}, cfg, { maxBackupTypesPerPoll: 2 });
  w.proc = __TAS__.createProcessor(w.deps);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL3).then(function () {
    assert.deepEqual(w.tokens, ['embed', 'site']);
  });
});
