/* Settings defaults, normalisation and playerType validation; GQL helpers; frame rules; stats. */
loadSrc('src/config.js', 'src/shared/settings.js', 'src/core/gql.js', 'src/shared/frame.js', 'src/shared/stats.js');
var ns = __TAS__;
var cfg = ns.config;
var S = ns.settings;
var G = ns.gql;

// ------------------------------------------------------------------ settings
test('defaults: playerTypes come from config, autoplay (360p bridge) last', function () {
  var d = S.defaults();
  assert.deepEqual(d.playerTypes, ['embed', 'site', 'mobile_web', 'popout', 'autoplay']);
  assert.ok(S.validatePlayerTypes(d.playerTypes).ok, 'the default passes the last-resort rule');
  assert.equal(d.enabled, true);
  assert.equal(d.blockTrackers, false);
  d.playerTypes.push('x');
  assert.equal(S.defaults().playerTypes.length, 5, 'defaults are a fresh copy');
});
test('normalize: the 1.x default order (stored on install) becomes the 2.0 default; own orders are kept', function () {
  var now = ['embed', 'site', 'mobile_web', 'popout', 'autoplay'];
  var old = S.normalize({ playerTypes: ['site', 'popout', 'mobile_web', 'embed', 'autoplay'] });
  assert.deepEqual(old.playerTypes, now);
  var old20 = S.normalize({ playerTypes: ['popout', 'embed', 'site', 'mobile_web'] });
  assert.deepEqual(old20.playerTypes, now, 'earlier 2.0 default migrated');
  var noAutoplay = S.normalize({ playerTypes: ['embed', 'site', 'mobile_web', 'popout'] });
  assert.deepEqual(noAutoplay.playerTypes, now, '2.0 default without autoplay migrated');
  var own = S.normalize({ playerTypes: ['site', 'popout', 'autoplay'] });
  assert.deepEqual(own.playerTypes, ['site', 'popout', 'autoplay'], 'a list the viewer chose stays');
});
test('normalize: blockClientAds keeps its stored value (same key, now VOD-only), default on', function () {
  assert.equal(S.defaults().blockClientAds, true);
  assert.equal(S.normalize({}).blockClientAds, true, 'missing: default');
  assert.equal(S.normalize({ blockClientAds: false }).blockClientAds, false, 'a viewer who turned it off keeps it off');
  assert.equal(S.normalize({ blockClientAds: 'yes' }).blockClientAds, true, 'corrupt: default');
  var stored = S.normalize({ enabled: true, blockClientAds: false, blockTrackers: true, hideStandaloneAds: false });
  assert.deepEqual([stored.blockClientAds, stored.blockTrackers, stored.hideStandaloneAds], [false, true, false]);
});
test('twitchAdQuality: defaults to low; normalize keeps low/full, unknown or missing -> low', function () {
  assert.equal(S.defaults().twitchAdQuality, 'low');
  assert.deepEqual(S.AD_QUALITY_VALUES, ['low', 'full']);
  assert.equal(S.normalize({ twitchAdQuality: 'full' }).twitchAdQuality, 'full');
  assert.equal(S.normalize({ twitchAdQuality: 'low' }).twitchAdQuality, 'low');
  assert.equal(S.normalize({ twitchAdQuality: 'HD' }).twitchAdQuality, 'low');
  assert.equal(S.normalize({ twitchAdQuality: true }).twitchAdQuality, 'low');
  assert.equal(S.normalize({}).twitchAdQuality, 'low', 'settings stored before the key existed');
});
test('twitchAdQuality: validate accepts low/full/absent, rejects anything else', function () {
  var base = S.defaults();
  assert.ok(S.validate(Object.assign({}, base, { twitchAdQuality: 'full' })).ok);
  assert.ok(S.validate(Object.assign({}, base, { twitchAdQuality: 'low' })).ok);
  var noKey = Object.assign({}, base); delete noKey.twitchAdQuality;
  assert.ok(S.validate(noKey).ok);
  var bad = S.validate(Object.assign({}, base, { twitchAdQuality: 'max' }));
  assert.notOk(bad.ok);
  assert.includes(bad.errors.join(' '), 'twitchAdQuality');
});
test('bridgePlayerTypes: autoplay then picture-by-picture, both known; autoplay asks as android', function () {
  assert.deepEqual(cfg.bridgePlayerTypes, ['autoplay', 'picture-by-picture']);
  cfg.bridgePlayerTypes.forEach(function (t) { assert.ok(cfg.knownPlayerTypes.indexOf(t) !== -1, t); });
  assert.equal(G.buildTokenBody(cfg, 'c', 'autoplay').variables.platform, 'android');
  assert.equal(G.buildTokenBody(cfg, 'c', 'picture-by-picture').variables.platform, 'web');
  assert.equal(G.buildTokenBody(cfg, 'c', 'picture-by-picture').variables.playerType, 'picture-by-picture');
});
test('config is frozen', function () {
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.backupPlayerTypes));
  assert.ok(Object.isFrozen(cfg.gql));
});
test('validatePlayerTypes accepts a valid custom order', function () {
  var v = S.validatePlayerTypes(['popout', 'site', 'autoplay']);
  assert.ok(v.ok);
  assert.deepEqual(v.value, ['popout', 'site', 'autoplay']);
});
test('validatePlayerTypes rejects empty, unknown, duplicates, autoplay not last, too many', function () {
  assert.notOk(S.validatePlayerTypes([]).ok);
  var u = S.validatePlayerTypes(['site', 'bogus']);
  assert.notOk(u.ok);
  assert.includes(u.errors.join(' '), 'Unknown playerType "bogus"');
  assert.includes(S.validatePlayerTypes(['site', 'site']).errors.join(' '), 'Duplicate');
  assert.includes(S.validatePlayerTypes(['autoplay', 'site']).errors.join(' '), 'must be last');
  assert.notOk(S.validatePlayerTypes(['site', 'popout', 'mobile_web', 'embed', 'frontpage', 'picture-by-picture', 'site', 'popout', 'autoplay']).ok);
  assert.notOk(S.validatePlayerTypes('site').ok);
  assert.notOk(S.validatePlayerTypes([5]).ok);
});
test('parsePlayerTypeText splits on newlines, commas and spaces', function () {
  assert.deepEqual(S.parsePlayerTypeText('site\npopout, mobile_web  embed\n\n'), ['site', 'popout', 'mobile_web', 'embed']);
  assert.deepEqual(S.parsePlayerTypeText(null), []);
});
test('normalize: partial / corrupt stored settings fall back per field', function () {
  var n = S.normalize({ enabled: false, debug: 'yes', playerTypes: ['bogus'], extra: 1 });
  assert.equal(n.enabled, false);
  assert.equal(n.debug, false);
  assert.deepEqual(n.playerTypes, cfg.backupPlayerTypes.slice());
  assert.equal(n.extra, undefined);
  assert.deepEqual(S.normalize(null), S.defaults());
  assert.deepEqual(S.normalize('garbage'), S.defaults());
});
test('validate: whole settings object', function () {
  assert.ok(S.validate(S.defaults()).ok);
  assert.notOk(S.validate(Object.assign(S.defaults(), { debug: 'on' })).ok);
  assert.notOk(S.validate(Object.assign(S.defaults(), { playerTypes: [] })).ok);
  assert.notOk(S.validate(null).ok);
});

// ------------------------------------------------------------------ gql
test('buildTokenBody: persisted query, web platform; autoplay uses android', function () {
  var b = G.buildTokenBody(cfg, 'somechannel', 'popout');
  assert.equal(b.operationName, 'PlaybackAccessToken');
  assert.equal(b.variables.login, 'somechannel');
  assert.equal(b.variables.playerType, 'popout');
  assert.equal(b.variables.platform, 'web');
  assert.equal(b.variables.isLive, true);
  assert.equal(b.extensions.persistedQuery.sha256Hash, '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712', 'current hash first');
  assert.equal(G.buildTokenBody(cfg, 'c', 'site', { hashIndex: 1 }).extensions.persistedQuery.sha256Hash, cfg.gql.persistedQueryHashes[1]);
  assert.equal(G.buildTokenBody(cfg, 'c', 'autoplay').variables.platform, 'android');
});
test('persisted query hashes: 64-hex values, current one first, older one kept as fallback', function () {
  var h = cfg.gql.persistedQueryHashes;
  assert.ok(h.length >= 2);
  h.forEach(function (x) { assert.ok(/^[0-9a-f]{64}$/.test(x), x); });
  assert.equal(h[0].indexOf('0828119d'), 0);
  assert.equal(h[1].indexOf('ed230aa1'), 0);
});
var PQNF = { errors: [{ message: 'PersistedQueryNotFound' }] };
var TOKEN_JSON = { data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } };
test('isPersistedQueryNotFound: object and batched forms; other errors are not', function () {
  assert.ok(G.isPersistedQueryNotFound(PQNF));
  assert.ok(G.isPersistedQueryNotFound([PQNF]));
  assert.notOk(G.isPersistedQueryNotFound({ errors: [{ message: 'service timeout' }] }));
  assert.notOk(G.isPersistedQueryNotFound(TOKEN_JSON));
  assert.notOk(G.isPersistedQueryNotFound(null));
});
test('fetchToken: PersistedQueryNotFound -> next hash; the answering hash is remembered', function () {
  var sent = [];
  var state = { hashIndex: 0 };
  function post(body) {
    sent.push(body.extensions.persistedQuery.sha256Hash);
    return Promise.resolve(body.extensions.persistedQuery.sha256Hash === cfg.gql.persistedQueryHashes[0] ? PQNF : TOKEN_JSON);
  }
  return G.fetchToken(cfg, post, 'c', 'embed', null, state).then(function (tok) {
    assert.deepEqual(tok, { value: 'v', signature: 's' });
    assert.deepEqual(sent, cfg.gql.persistedQueryHashes.slice(0, 2));
    assert.equal(state.hashIndex, 1);
    sent = [];
    return G.fetchToken(cfg, post, 'c', 'site', null, state);
  }).then(function (tok) {
    assert.deepEqual(tok, { value: 'v', signature: 's' });
    assert.deepEqual(sent, [cfg.gql.persistedQueryHashes[1]], 'stale hash not tried again');
  });
});
test('fetchToken: every hash rejected or no response -> null, no endless retry', function () {
  var n = 0;
  return G.fetchToken(cfg, function () { n++; return Promise.resolve(PQNF); }, 'c', 'embed', null, {}).then(function (tok) {
    assert.equal(tok, null);
    assert.equal(n, cfg.gql.persistedQueryHashes.length);
    n = 0;
    return G.fetchToken(cfg, function () { n++; return Promise.resolve(null); }, 'c', 'embed', null, {});
  }).then(function (tok) {
    assert.equal(tok, null);
    assert.equal(n, 1, 'a failed request is not retried with another hash');
  });
});
test('buildTokenHeaders: captured values used, fallbacks otherwise', function () {
  var h = G.buildTokenHeaders(cfg, { 'client-id': 'cid', 'x-device-id': 'dev', authorization: 'OAuth abc', 'client-integrity': 'ci', 'client-version': 'cv', 'client-session-id': 'cs' }, 'fallback');
  assert.equal(h['Client-ID'], 'cid');
  assert.equal(h['Device-ID'], 'dev');
  assert.equal(h.Authorization, 'OAuth abc');
  assert.equal(h['Client-Integrity'], 'ci');
  assert.equal(h['Client-Version'], 'cv');
  assert.equal(h['Client-Session-Id'], 'cs');
  var a = G.buildTokenHeaders(cfg, {}, 'fallback');
  assert.equal(a['Client-ID'], cfg.gql.clientId);
  assert.equal(a['Device-ID'], 'fallback');
  assert.equal(a.Authorization, 'undefined');
  assert.equal(a['Client-Integrity'], undefined);
});
test('extractHeaders from object, array and Headers-like', function () {
  assert.deepEqual(G.extractHeaders(cfg, { 'Client-ID': 'a', Authorization: 'OAuth x', 'X-Other': 'no' }), { 'client-id': 'a', authorization: 'OAuth x' });
  assert.deepEqual(G.extractHeaders(cfg, [['Device-ID', 'd'], ['Accept', '*/*']]), { 'device-id': 'd' });
  var fake = { forEach: function (cb) { cb('v1', 'client-version'); cb('x', 'content-type'); } };
  assert.deepEqual(G.extractHeaders(cfg, fake), { 'client-version': 'v1' });
  assert.deepEqual(G.extractHeaders(cfg, null), {});
});
test('parseTokenResponse: object, batched array, missing', function () {
  var tok = { data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } };
  assert.deepEqual(G.parseTokenResponse(tok), { value: 'v', signature: 's' });
  assert.deepEqual(G.parseTokenResponse([{ data: {} }, tok]), { value: 'v', signature: 's' });
  assert.equal(G.parseTokenResponse({ errors: [{ message: 'PersistedQueryNotFound' }] }), null);
  assert.equal(G.parseTokenResponse(null), null);
});
test('rewritePlayerType: site live token -> popout (single and batched); others untouched', function () {
  var one = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true, isVod: false, login: 'c', playerType: 'site' } });
  var r = G.rewritePlayerType(one, cfg);
  assert.ok(r.changed);
  assert.equal(JSON.parse(r.body).variables.playerType, 'popout');
  var batch = JSON.stringify([{ operationName: 'Other', variables: { playerType: 'site' } }, { operationName: 'PlaybackAccessToken', variables: { isLive: true, isVod: false, playerType: 'site' } }]);
  var rb = JSON.parse(G.rewritePlayerType(batch, cfg).body);
  assert.equal(rb[0].variables.playerType, 'site');
  assert.equal(rb[1].variables.playerType, 'popout');
  var embed = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true, isVod: false, playerType: 'embed' } });
  assert.notOk(G.rewritePlayerType(embed, cfg).changed);
  var vod = JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: false, isVod: true, playerType: 'site' } });
  assert.notOk(G.rewritePlayerType(vod, cfg).changed);
  assert.equal(G.rewritePlayerType('{not json PlaybackAccessToken', cfg).changed, false);
  assert.equal(G.rewritePlayerType(undefined, cfg).changed, false);
});
// Client-side ad via GQL (live run 2026-11-23 jynxzi): FetchAdsService_FetchAds answered with a
// VAST for an OUTSTREAM_MIRROR_PBYP_VIDEO ad that then played above chat.
var EMPTY_VAST = '<?xml version="1.0" encoding="UTF-8"?><VAST version="3.0"></VAST>';
function fetchAdsAnswer() {
  return { data: { fetchAds: { ads: { format: 'OUTSTREAM_MIRROR_PBYP_VIDEO', vast: '<VAST version="3.0"><Ad id="1"><InLine></InLine></Ad></VAST>' }, other: 1 } }, extensions: { operationName: 'FetchAdsService_FetchAds' } };
}
test('clientAdGqlOperations: FetchAdsService_FetchAds', function () {
  assert.deepEqual(ns.config.clientAdGqlOperations, ['FetchAdsService_FetchAds']);
});
test('isClientAdGqlRequest: single and batched bodies naming a listed operation; others, non-JSON, non-string: no', function () {
  var G = ns.gql, cfg = ns.config;
  assert.ok(G.isClientAdGqlRequest(JSON.stringify([{ operationName: 'FetchAdsService_FetchAds', variables: { input: {} } }]), cfg));
  assert.ok(G.isClientAdGqlRequest(JSON.stringify({ operationName: 'FetchAdsService_FetchAds' }), cfg));
  assert.ok(G.isClientAdGqlRequest(JSON.stringify([{ operationName: 'ChannelShell' }, { operationName: 'FetchAdsService_FetchAds' }]), cfg));
  assert.notOk(G.isClientAdGqlRequest(JSON.stringify([{ operationName: 'ChannelShell', variables: { note: 'FetchAdsService_FetchAds' } }]), cfg));
  assert.notOk(G.isClientAdGqlRequest('FetchAdsService_FetchAds{', cfg));
  assert.notOk(G.isClientAdGqlRequest(null, cfg));
});
test('neutraliseFetchAds: batched answer -> vast emptied, other fields and items untouched', function () {
  var G = ns.gql;
  var other = { data: { channel: { id: '1' } } };
  var json = [other, fetchAdsAnswer()];
  var r = G.neutraliseFetchAds(json, EMPTY_VAST);
  assert.ok(r.changed);
  assert.equal(r.json[1].data.fetchAds.ads.vast, EMPTY_VAST);
  assert.equal(r.json[1].data.fetchAds.ads.format, 'OUTSTREAM_MIRROR_PBYP_VIDEO');
  assert.equal(r.json[1].data.fetchAds.other, 1);
  assert.deepEqual(r.json[0], { data: { channel: { id: '1' } } });
});
test('neutraliseFetchAds: single object answer; unexpected shapes unchanged', function () {
  var G = ns.gql;
  var r = G.neutraliseFetchAds(fetchAdsAnswer(), EMPTY_VAST);
  assert.ok(r.changed);
  assert.equal(r.json.data.fetchAds.ads.vast, EMPTY_VAST);
  [null, 'x', 3, {}, [], [{ data: null }], { data: { fetchAds: null } }, { data: { fetchAds: { ads: null } } },
    { data: { fetchAds: { ads: { vast: 5 } } } }, { data: { fetchAds: { ads: [{ vast: '<VAST/>' }] } } }].forEach(function (j) {
    assert.notOk(G.neutraliseFetchAds(j, EMPTY_VAST).changed, JSON.stringify(j));
  });
});

test('randomDeviceId: 32 chars [a-z0-9]', function () {
  assert.ok(/^[a-z0-9]{32}$/.test(G.randomDeviceId()));
});

// ------------------------------------------------------------------ frames
test('shouldRunInFrame: top frame yes, clips and clip pages no, player sub-frames only', function () {
  var F = ns.frame;
  assert.ok(F.shouldRunInFrame('www.twitch.tv', '/somechannel', true));
  assert.notOk(F.shouldRunInFrame('clips.twitch.tv', '/Slug', true));
  assert.notOk(F.shouldRunInFrame('www.twitch.tv', '/somechannel/clip/SomeSlug', true));
  assert.ok(F.shouldRunInFrame('player.twitch.tv', '/', false));
  assert.ok(F.shouldRunInFrame('www.twitch.tv', '/embed/somechannel/chat', false));
  assert.notOk(F.shouldRunInFrame('www.twitch.tv', '/somechannel', false));
  assert.notOk(F.shouldRunInFrame('passport.twitch.tv', '/', false));
});

// ------------------------------------------------------------------ stats / popup status
test('stats: applyEvent counts once per event type, badge sums blocked', function () {
  var St = ns.stats;
  var s = St.empty();
  ['ad-detected', 'ad-blocked-backup', 'ad-detected', 'ad-stripped', 'ad-blanked', 'failure', 'ad-unremovable', 'standalone-ad-hidden', 'ad-end', 'unknown'].forEach(function (n) { s = St.applyEvent(s, n); });
  assert.deepEqual(s, { detected: 2, backup: 1, stripped: 2, failures: 2, standalone: 1, reloads: 0 });
  assert.equal(St.badgeText(s), '4');
  assert.equal(St.badgeText(St.empty()), '');
  assert.equal(St.badgeText({ backup: 5000 }), '999+');
  assert.deepEqual(St.normalize({ detected: -1, backup: 'x' }), St.empty());
});
test('stats: describeEvent and toast texts', function () {
  var St = ns.stats;
  assert.includes(St.describeEvent('ad-blocked-backup', { playerType: 'popout', channel: 'c', midroll: true }), 'Midroll ad blocked using backup stream "popout" (c)');
  assert.equal(St.describeEvent('nope', {}), null);
  assert.includes(St.toastText('ad-blocked-backup'), 'using backup stream');
  assert.equal(St.toastText('ad-detected'), null);
  assert.equal(St.toastText('ad-blanked'), St.toastText('ad-stripped'));
  assert.ok(St.isCounted('ad-blanked'));
  assert.includes(St.describeEvent('ad-blanked', { channel: 'c', blanked: 15 }), 'Preroll ad blocked by blanking 15 ad segment(s) (c)');
  assert.ok(St.describeEvent('ad-passthrough', {}), 'old event name still described');
});
test('popupStatus covers every state', function () {
  var P = ns.stats.popupStatus;
  assert.equal(P({ url: 'https://example.com/', enabled: true }).key, 'not-twitch');
  assert.equal(P({ url: undefined, enabled: true }).key, 'not-twitch');
  assert.equal(P({ url: 'https://clips.twitch.tv/x', enabled: true }).text, 'Not active on clips');
  assert.equal(P({ url: 'https://www.twitch.tv/c', enabled: false, hooked: false }).key, 'disabled');
  var d = P({ url: 'https://www.twitch.tv/c', enabled: false, hooked: true });
  assert.equal(d.key, 'disabled');
  assert.ok(d.reload);
  var r = P({ url: 'https://www.twitch.tv/c', enabled: true, hooked: false });
  assert.equal(r.key, 'reload');
  assert.ok(r.reload);
  assert.equal(P({ url: 'https://www.twitch.tv/c', enabled: true, hooked: true, degraded: true }).key, 'degraded');
  assert.equal(P({ url: 'https://www.twitch.tv/c', enabled: true, hooked: true }).key, 'active');
  assert.equal(P({ url: 'https://twitch.tv/c', enabled: true, hooked: true }).key, 'active');
  assert.equal(P({ url: 'https://evil-twitch.tv/c', enabled: true, hooked: true }).key, 'not-twitch');
});
