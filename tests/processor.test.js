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
    assert.equal(out, cleanFor('popout'));
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
    assert.equal(out, cleanFor('popout'));
    assert.deepEqual(w.tokens, [], 'no new token');
    assert.deepEqual(w.fetched, [backupMedia720('popout')], 'only the backup media playlist fetched');
    assert.equal(w.names().filter(function (n) { return n === 'ad-blocked-backup'; }).length, 1, 'counted once per break');
  });
});

test('break end: native playlist served again, ad-end and switch back emitted', function () {
  var w = makeWorld({ site: PREROLL, popout: cleanFor('popout') });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function () {
    return w.proc.onMedia(NATIVE_720, CLEAN);
  }).then(function (out) {
    assert.equal(out, CLEAN);
    var names = w.names();
    assert.deepEqual(names.slice(-2), ['ad-end', 'playlist-switch']);
    assert.equal(w.events[w.events.length - 1].data.to, 'native');
    assert.equal(w.events[w.events.length - 2].data.outcome, 'backup');
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

test('stripping empties the playlist: last clean playlist served while fresh', function () {
  var w = makeWorld(allTypes(PREROLL));
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, CLEAN).then(function () {
    w.t += 2000;
    return w.proc.onMedia(NATIVE_720, fixture('all-ads.m3u8'));
  }).then(function (out) {
    assert.equal(out, CLEAN);
    w.t += cfg.lastCleanMaxAgeMs + 1;
    return w.proc.onMedia(NATIVE_720, fixture('all-ads.m3u8'));
  }).then(function (out) {
    assert.equal(M.countSegments(out), 0, 'stale last-clean not used');
  });
});

test('token error for one type: locked out, next type used', function () {
  var w = makeWorld({ popout: cleanFor('popout') }, { tokenThrows: { site: true } });
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.equal(out, cleanFor('popout'));
    assert.ok(w.proc.stateOf('somechannel').lockouts.site > w.t);
  });
});

test('autoplay is used as last resort but never pinned', function () {
  var types = allTypes(PREROLL);
  types.autoplay = cleanFor('autoplay');
  var w = makeWorld(types);
  w.proc.onMaster(MASTER_URL, MASTER);
  return w.proc.onMedia(NATIVE_720, PREROLL).then(function (out) {
    assert.equal(out, cleanFor('autoplay'));
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
    assert.equal(out, cleanFor('embed'));
    assert.deepEqual(w.tokens, ['embed']);
  });
});
