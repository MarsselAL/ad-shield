/*
 * Twitch Ad Shield - single source of truth for everything Twitch can change.
 *
 * When Twitch changes something (a marker string, the persisted query hash, a playerType
 * that stops working), this is the ONLY file that should need editing. Every other module
 * (page script, worker, cosmetic script, background, tests) reads these values.
 *
 * Rules for this file:
 *  - Plain data only (strings, numbers, booleans, arrays, plain objects). It is JSON-serialised
 *    into the video worker, so no RegExp objects and no functions. Patterns are strings and are
 *    compiled by the code that uses them.
 *  - Every value carries a comment saying where it came from. "research-technique.md §x" refers
 *    to docs/research-technique.md, "research-github.md" to docs/research-github.md.
 *
 * Loaded as a classic script in: the MAIN world (page), the ISOLATED world (bridge/cosmetic),
 * the background service worker (importScripts), the popup/options pages and the jsc tests.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) {
    ns = {};
    // Non-enumerable so it does not show up when the page enumerates window.
    Object.defineProperty(root, '__TAS__', { value: ns, configurable: true, writable: true, enumerable: false });
  }

  var config = {
    version: '1.0.0',

    // Namespaced key used on every message we exchange (worker <-> page, page <-> bridge).
    // Our own choice; anything not carrying this key is ignored and passed through.
    messageKey: '__tas_v1',

    // DOM event names used between the MAIN-world page script and the ISOLATED-world bridge.
    // Our own choice. Payloads are JSON strings (object details do not cross worlds reliably).
    events: {
      toBridge: 'tas:to-bridge',
      toPage: 'tas:to-page'
    },

    // ---------------------------------------------------------------------------------------
    // Ad detection in media playlists
    // ---------------------------------------------------------------------------------------

    // Substrings that mark a media playlist as containing an ad.
    // Source: research-technique.md §2.1, ryanbr vaft AdSignifiers (R l.64), checked 2026-11-11.
    adMarkers: [
      'stitched-ad',
      'EXT-X-CUE-OUT',
      'twitch-stitched',
      'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'
    ],

    // DATERANGE classes that mark ads (used when classifying / removing DATERANGE lines).
    // Source: research-technique.md §2.1 (same list as adMarkers, class form) and
    // research-github.md "How current Twitch ads are delivered" (twitch-stitched-ad, twitch-maf-ad).
    // 'twitch-trigger' was removed on 2026-11-11: a live probe showed it in EVERY playlist of a
    // live channel (all playerTypes, zero ad segments), so treating it as an ad was a false positive.
    adDaterangeClasses: ['twitch-stitched-ad', 'twitch-maf-ad'],

    // DATERANGE classes that appear in normal playlists and are NOT ads. Lines with these
    // classes are ignored by detection and kept by stripping.
    // Source: research-technique.md §2.1 (R l.68).
    ignoredDaterangeClasses: ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment', 'twitch-trigger', 'timestamp'],

    // Strings that mark an ad break as a midroll (otherwise it is treated as a preroll).
    // Source: research-technique.md §2.2 (IsMidroll in P/R).
    midrollMarkers: ['"MIDROLL"', '"midroll"'],

    // Live content segments have this in their #EXTINF title ("#EXTINF:2.000,live").
    // An #EXTINF without it, in a live playlist, is an ad segment.
    // Source: research-technique.md §2.3.
    liveSegmentTitle: 'live',

    // #EXTINF titles that start with this are ad segments ("Amazon|<id>").
    // Source: research-github.md "How current Twitch ads are delivered" item 1 (Purple B-007..B-009).
    adSegmentTitlePrefixes: ['Amazon'],

    // Segment URL substrings that identify ad media.
    // Source: research-technique.md §2.1 (R l.69).
    adSegmentUrlPatterns: ['/adsquared/', '/_404/', '/processing'],

    // Low-latency prefetch tag, removed whenever a playlist has ads.
    // Source: research-technique.md §2.3.
    prefetchTag: '#EXT-X-TWITCH-PREFETCH:',

    // Ad attribute names whose URL values are neutralised in kept DATERANGE lines (tracking URLs).
    // Source: research-technique.md §2.1 (R l.1218). Stored as a RegExp source string.
    adUrlAttributePattern: '(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")',

    // ---------------------------------------------------------------------------------------
    // Access tokens (GQL) and usher
    // ---------------------------------------------------------------------------------------

    gql: {
      // Source: research-technique.md §1.1.
      url: 'https://gql.twitch.tv/gql',
      // Public web Client-ID used by twitch.tv itself. Source: research-technique.md §1.1.
      clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      operationName: 'PlaybackAccessToken',
      // Persisted query hash for PlaybackAccessToken. Source: research-technique.md §1.1
      // (identical in pixeltris and ryanbr vaft, checked 2026-11-11). If token requests start
      // failing with "PersistedQueryNotFound", this is the value to update.
      persistedQueryHash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
      // playerType that uses platform "android" instead of "web". Source: research-technique.md §1.1/§4.1.
      androidPlatformPlayerTypes: ['autoplay'],
      // Headers copied from the page's own GQL requests. Source: research-technique.md §1.1.
      capturedHeaders: ['client-id', 'device-id', 'x-device-id', 'authorization', 'client-integrity', 'client-version', 'client-session-id']
    },

    // The playerType the page's own (main) live token request is rewritten to.
    // Source: research-technique.md §3 item 7 and research-github.md item 5 ("site" tokens and
    // parent_domains yield fake ads; vaft/Purple ask as "popout"). Set to '' to disable rewriting.
    forcedPlayerType: 'popout',
    // Only page token requests with this playerType are rewritten (we leave embed / pbp alone).
    // Our conservative choice, see docs/ARCHITECTURE.md.
    forcedPlayerTypeFrom: ['site'],
    // Query parameters removed from the usher master URL when forcedPlayerType is active.
    // Source: research-technique.md §1.2 (vaft deletes parent_domains).
    usherDropParams: ['parent_domains'],

    // Usher master playlist URL patterns (RegExp source strings).
    // Source: research-technique.md §1.2 (/api/channel/hls/ and /api/v2/channel/hls/).
    usherLivePattern: '^https://usher\\.ttvnw\\.net/api/(?:v2/)?channel/hls/([^/?#]+)\\.m3u8',
    // VOD masters: no backups (no ad-free alternative), detection + strip only. Our choice.
    usherVodPattern: '^https://usher\\.ttvnw\\.net/(?:api/(?:v2/)?)?vod/([^/?#]+)\\.m3u8',
    // Masters containing this are the mini player above chat; left untouched.
    // Source: research-technique.md §3 item 4(c).
    usherIgnoreSubstrings: ['picture-by-picture'],

    // Backup playerType order. Source: research-technique.md §4.1 (ryanbr v68.5.7, current):
    // site, popout, mobile_web, embed, then autoplay (360p, platform android) only as last resort.
    backupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed', 'autoplay'],
    // playerTypes the options page accepts. The first five are research-technique.md §4.1,
    // frontpage is research-github.md (Purple B-012), picture-by-picture is video-swap-new (§4.1).
    knownPlayerTypes: ['site', 'popout', 'mobile_web', 'embed', 'autoplay', 'frontpage', 'picture-by-picture'],
    // These are never "pinned" as the preferred backup. Source: research-technique.md §4.1.
    neverPinPlayerTypes: ['autoplay'],
    // Must be last in the list if present. Source: research-technique.md §4.1 (endless loading
    // when autoplay is the committed backup).
    lastResortPlayerTypes: ['autoplay'],
    maxPlayerTypes: 8,

    // Codec prefixes. Source: research-technique.md §4.3 (avc*/av0* vs hev*/hvc*; AV1 is av01).
    avcCodecPrefixes: ['avc1', 'avc3'],
    hevcCodecPrefixes: ['hev1', 'hvc1'],
    av1CodecPrefixes: ['av01'],

    // ---------------------------------------------------------------------------------------
    // Timeouts and limits (our choices; research-technique.md §4.1/§4.4/§5 give the ranges)
    // ---------------------------------------------------------------------------------------
    tokenTimeoutMs: 5000,            // page GQL token request
    fetchTimeoutMs: 5000,            // backup usher/media fetch from the worker
    maxBackupTypesPerPoll: 5,        // max playerTypes tried for one playlist poll
    playerTypeLockoutMs: 5000,       // a failed type is skipped for this long (R: 5 s, §4.1)
    backupMasterTtlMs: 60000,        // cached backup master per type
    lastCleanMaxAgeMs: 20000,        // last clean playlist may be served this long when stripping empties it
    adSegmentCacheTtlMs: 120000,     // ad segment URLs remembered (P/R: 120 s, §2.3)
    maxTrackedPlaylists: 200,        // memory bound for playlist/variant maps

    // Recovery (page). research-technique.md §5.
    recovery: {
      watchWindowMs: 20000,          // after a playlist switch, watch the video this long
      checkIntervalMs: 1000,         // sample interval while watching (no timer otherwise)
      stallThresholdMs: 4000,        // currentTime not advancing this long = stalled
      maxReloadsPerWindow: 3,        // hard reloads per channel ...
      reloadWindowMs: 300000,        // ... per 5 minutes; above that the channel goes strip-only
      preserveWindowMs: 5000,        // localStorage values are pinned this long around a reload
      preservedLocalStorageKeys: ['video-quality', 'video-muted', 'volume', 'lowLatencyModeEnabled'] // §5
    },

    // Selectors / React keys used for the player reload. Source: research-technique.md §5.
    player: {
      rootSelector: '#root',
      videoSelector: 'video',
      playerContainerSelector: '.video-player'
    },

    // Tiny valid responses served for ad segment fetches (research-technique.md §3 item 4(a)).
    // .ts: one MPEG-TS null packet (188 bytes, PID 0x1FFF). Other: a 40-byte MP4 'ftyp' box.
    blankTsBase64: 'Rx//EP////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8=',
    blankMp4Base64: 'AAAAKGZ0eXBtcDQyAAAAAG1wNDJtcDQxaXNvbWlzbzJhdmMxZGFzaA==',

    // ---------------------------------------------------------------------------------------
    // Frames and pages
    // ---------------------------------------------------------------------------------------
    // Sub-frames are skipped unless they are the Twitch player. Source: research-technique.md §3 item 6.
    allowedFrameHosts: ['player.twitch.tv', 'embed.twitch.tv'],
    allowedFramePathPrefix: '/embed/',
    // Clip pages have no HLS ads; skipped. Source: research-technique.md §3 item 6.
    skipPathPattern: '^/[^/]+/clip/',

    // ---------------------------------------------------------------------------------------
    // Cosmetic (ISOLATED world)
    // ---------------------------------------------------------------------------------------
    cosmetic: {
      // Standalone ad <video> elements beside the player / in chat since ~July 2026.
      // Source: research-technique.md §7 (uAssets quick-fixes l.511-512:
      // video[src^="https://m.media-amazon.com"]) and research-github.md item 4.
      adVideoSelectors: ['video[src*="media-amazon.com"]', 'video[src*="amazon-adsystem.com"]'],
      // Hosts checked on a playing video's currentSrc (covers <source> children).
      adVideoHosts: ['media-amazon.com', 'amazon-adsystem.com'],
      // Twitch "commercial break" / ad banner overlay selectors. The research did not identify
      // stable ones (class names changed repeatedly, research-github.md "uBO cosmetic filters"),
      // so this is intentionally empty. Add verified selectors here.
      overlaySelectors: [],
      throttleMs: 300
    },

    // Badge colour (our choice).
    badgeColor: '#6b46c1'
  };

  (function deepFreeze(o) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) {
      if (o[k] && typeof o[k] === 'object' && !Object.isFrozen(o[k])) deepFreeze(o[k]);
    });
  })(config);

  ns.config = config;
})(typeof globalThis !== 'undefined' ? globalThis : this);
