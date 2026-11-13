# Twitch video-ad blocking: source-level technique spec

Date of research: 2026-11-11. Sources were cloned (depth 50) and read, never executed.
Legend: CHECKED = I read it in the source. REPORTED = a changelog/README says so. UNKNOWN = not verified.

## 0. Sources and licenses

| Project | Commit date read | License | Status |
|---|---|---|---|
| pixeltris/TwitchAdSolutions (`vaft/vaft.user.js` v37.0.0 / internal v24, `video-swap-new/video-swap-new.user.js` v1.55) | last commit 2026-03-05 | Check `LICENSE` file in repo (not opened beyond header; UNKNOWN which) | README says "Project archived on 2026-03-05" (CHECKED) |
| ryanbr/TwitchAdSolutions (`vaft/vaft.user.js` v68.5.7 / internal v93, 3111 lines) | last commit 2026-08-27 | same LICENSE as upstream (UNKNOWN exact text) | NEWEST, actively maintained. Use it as the reference. |
| younesaassila/ttv-lol-pro v2.6.2 | last commit 2026-06-19 | GPL-3.0 (`COPYING`, CHECKED) | active |
| uBlockOrigin/uAssets | filters.txt / quick-fixes.txt master | GPL-3.0 / CC0 (UNKNOWN, not checked) | minor relevance |

GPL-3.0 means: do not copy ttv-lol-pro code into a non-GPL extension. Re-implement from this spec. For the vaft code, check its LICENSE before copying; paraphrase to be safe.

Paths below: `P:` = pixeltris vaft.user.js, `R:` = ryanbr vaft/vaft.user.js, `S:` = pixeltris video-swap-new.user.js, `T:` = ttv-lol-pro `src/`.

## 1. How the player fetches video

### 1.1 Access token (GQL)
Endpoint `https://gql.twitch.tv/gql`, POST (P: gqlRequest ~l.650; R: l.1892-1950). Persisted-query body used by vaft for backups (CHECKED, identical in P and R):

```js
{ operationName:'PlaybackAccessToken',
  variables:{ isLive:true, login:channel, isVod:false, vodID:"",
              playerType:<type>, platform: type=='autoplay' ? 'android' : 'web' },
  extensions:{ persistedQuery:{ version:1,
     sha256Hash:'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9' } } }
```
Headers: `Client-ID: kimne78kx3ncx6brgo4mv6wki5h1ko`, `X-Device-Id` (32 random [a-z0-9] if none captured), `Authorization` (copied from the page's own GQL call; `undefined` string if anonymous), optional `Client-Integrity`, `Client-Version`, `Client-Session-Id` (all copied from the page's own GQL requests by hooking `window.fetch`; P: hookFetch ~l.905-960). The page's own request uses header `Device-ID` or `X-Device-Id` (vaft checks both).
Response path: `data.streamPlaybackAccessToken.{value,signature}`.
Alternative (ttv-lol-pro, T: page/getFetch.ts ~l.1165-1200): full-text query `PlaybackAccessToken_Template` with variables `{isLive, isVod, login, platform:"web", playerType:"site", vodID}` and headers `Authorization: OAuth <auth-token cookie>` or `undefined`, `Client-ID` same, `Content-Type: text/plain; charset=UTF-8`, `Device-ID`.
Key point: the worker cannot reuse the credentialed page session, so vaft's worker posts a `FetchRequest` message to the page thread, which calls the REAL fetch (`window.realFetch`) and replies `FetchResponse` (P: handleWorkerFetchRequest).

### 1.2 Master playlist (usher)
`https://usher.ttvnw.net/api/channel/hls/<channel>.m3u8?<params>` (or `/api/v2/channel/hls/...` when the page URL contains `/api/v2/`; vaft sets `V2API = url.includes('/api/v2/')`, added upstream 2025-11-04 "v2 api support #461"). `<params>` = whatever the page sent (copied verbatim as `UsherParams = new URL(url).search`) plus `sig` and `token` replaced for backups (P: processM3U8 ~l.520). When `ForceAccessTokenPlayerType` is set, vaft deletes the `parent_domains` query param from the page's usher URL (P: l.~270) because it marks the player as embedded and "gets rid of fake ads" (comment in source).
Master SERVER-TIME is read with `SERVER-TIME="([0-9.]+)"` (v1) or `#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="..."` (v2) and re-injected into cached/backup master playlists so the player clock stays consistent.

### 1.3 Media playlists
Lines after `#EXT-X-STREAM-INF` in the master (contain `.m3u8`, hosted on `*.playlist.live-video.net` / `video-weaver.*.hls.ttvnw.net`, regex in T: common/ts/regexes.ts `videoWeaverHostRegex`). vaft hooks any fetched URL that ends in `m3u8` and only processes it if it is in `StreamInfosByUrl` (filled when the master was parsed). Each `STREAM-INF` yields `{Resolution, FrameRate, Codecs, Url}`.

## 2. How ads appear in playlists

### 2.1 Detection markers (exact strings)
- pixeltris (stale): `AdSignifier = 'stitched'` (P l.~21) -- plain substring on the media playlist. video-swap-new: `'stitched-ad'`.
- ryanbr (current) `AdSignifiers` (R l.64), CHECKED:
  `['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"', 'EXT-X-DATERANGE:CLASS="twitch-trigger"']`
  Known NON-ad DATERANGE classes to ignore (R l.68): `twitch-session`, `twitch-stream-source`, `twitch-ad-quartile`, `twitch-assignment`.
- ttv-lol-pro uses only `"stitched-ad"` (lowercased body) (T: getFetch.ts l.738).
- Ad attributes (high confidence): `X-TV-TWITCH-AD-AD-SESSION-ID`, `X-TV-TWITCH-AD-RADS-TOKEN`, `X-TV-TWITCH-AD-POD-LENGTH="n"`, `X-TV-TWITCH-AD-URL`, `X-TV-TWITCH-AD-CLICK-TRACKING-URL` (R l.1218; regex rewrite `/(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g` replaces values with `https://twitch.tv`, to kill the tracking URLs shown in the overlay).
- Segment ad-URL patterns (R l.69): `/adsquared/`, `/_404/`, `/processing`.
- Generic scan for unknown tags: `/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi` (diagnostic only). SCTE-35: `EXT-X-CUE-OUT` begins, `EXT-X-CUE-IN` ends an ad boundary; while inside CUE-OUT every `#EXTINF` is treated as ad (R l.936-958).
- I found no use of the strings "Amazon" or "SCTE35" in the playlist detection itself; "Amazon" only appears for the separate `<video>` ad elements (see 8).

### 2.2 Preroll vs midroll
`IsMidroll = text.includes('"MIDROLL"') || text.includes('"midroll"')` (P/R). For a NON-midroll (preroll) break vaft also fetches ONE ad `.ts` segment per playlist poll (first `#EXTINF` whose line lacks `,live`), response discarded, "so the stream starts faster" (P ~l.468-482). Not done for midrolls.

### 2.3 Which segments are ad segments
`#EXTINF` lines whose title does NOT contain `,live` are ad segments (live content is `#EXTINF:2.000,live`). They go into `AdSegmentCache` (Map url -> timestamp, pruned after 120 s). If the playlist has an ad signifier at all, `#EXT-X-TWITCH-PREFETCH:` lines are blanked (no low-latency during ads). R additionally strips `#EXT-X-PART:` whose URI is cached/pattern-matched and `#EXT-X-PRELOAD-HINT`.

## 3. Web Worker hooking

Twitch plays through a Worker created from a blob URL on a `*.twitch.tv` origin (amazon-ivs wasm worker). Mechanism (P: hookWindowWorker ~l.100-200), CHECKED:
1. Replace `window.Worker` with `class Worker extends <clean Worker>`. In the constructor test `new URL(arg).origin.endsWith('.twitch.tv')`; otherwise call `super` untouched.
2. Fetch Twitch's worker source SYNCHRONOUSLY: `XMLHttpRequest GET (blobUrl, async=false)`, `overrideMimeType('text/javascript')` (`getWasmWorkerJs`).
3. Build a new blob: our functions serialised with `fn.toString()` (stripAdSegments, processM3U8, hookWorkerFetch, getAccessToken, gqlRequest, parseAttributes, ...), initial values injected as string literals (`GQLDeviceID`, `AuthorizationHeader`, `ClientIntegrityHeader`, `ClientVersion`, `ClientSession`), a `message` listener, `hookWorkerFetch();` then `eval(workerString)` (Twitch's original code). `super(URL.createObjectURL(new Blob([newBlobStr])), options)`.
   ttv-lol-pro variant (T: page/getWorker.ts): blob text = `importScripts('<extension worker.js URL>'); <original script>`, wrapped once more in a second blob that does `importScripts(newScriptURL)` for VAFT compatibility. Also fetches original via sync XHR.
   Serialised functions cannot reference outer-scope variables (ryanbr CLAUDE.md "Worker Blob Serialization (CRITICAL)").
4. In-worker `hookWorkerFetch`: `fetch = async (url, opts) => ...`: (a) if `url` is in `AdSegmentCache`, return a fetch of a tiny valid blank MP4 `data:video/mp4;base64,AAAAKGZ0eXBtcDQy...` (so the player does not download ad media); (b) if url ends `m3u8`: fetch, and when status 200 return `new Response(await processM3U8(...))`; (c) if url includes `/channel/hls/` and not `picture-by-picture`: it is the usher master request; parse, cache `StreamInfos[channel]`, build maps, return the master text with fresh SERVER-TIME.
5. Worker<->page messages (both directions, `{key, value}`), CHECKED in P:
   - page->worker: `UpdateClientVersion`, `UpdateClientSession`, `UpdateClientId`, `UpdateDeviceId`, `UpdateClientIntegrityHeader`, `UpdateAuthorizationHeader`, `FetchResponse`, `TriggeredPlayerReload`, (`SimulateAds`, `AllSegmentsAreAdSegments` debug).
   - worker->page: `UpdateAdBlockBanner`, `PauseResumePlayer`, `ReloadPlayer`, `FetchRequest`.
6. Re-hook guard: `Object.defineProperty(window,'Worker',{get,set})` where `set` rejects values whose source includes `'twitch'` or `'isVariantA'` (competing blockers, TwitchNoSub), and a prototype-chain cleanup (getCleanWorker/getWorkersForReinsert). R adds nested-frame filter (only top frame or hosts `player.twitch.tv`, `embed.twitch.tv`, paths `/embed/`), skips `clips.twitch.tv` and `/<ch>/clip/<slug>`, and avoids re-injecting a blob that already carries its hooks (changelog v68.x, REPORTED+CHECKED).
7. Page-side `window.fetch` hook: capture the headers above; also if request body contains `PlaybackAccessToken` and `picture-by-picture`, blank the body (kills the mini player above chat); and rewrite `variables.playerType` of the page's own token request to `ForceAccessTokenPlayerType = 'popout'` (handles batched array bodies). Rationale: the main stream itself is requested as `popout` (R: v68 changelog / P l.~38).

## 4. Backup-stream strategy

### 4.1 playerType order
| Script | BackupPlayerTypes | Fallback | Forced main type |
|---|---|---|---|
| pixeltris vaft (stale, 2026-02) | `embed`, `popout`, `autoplay` (comment `picture-by-picture-CACHED` disabled) | `embed` | `popout` |
| ryanbr vaft v68.5.7 (CURRENT) | `site`, `popout`, `mobile_web`, `embed`; `autoplay` appended last when `PreferLowQualityBackup` | `site` | `popout` |
| video-swap-new | `autoplay`, `picture-by-picture`, `embed` | n/a | `popout` |

ryanbr notes (CHECKED comments R l.72-79 + CHANGELOG): `embed` GQL token returns "server error" from the twitch.tv origin (so moved to 4th); `autoplay` (360p, `platform:'android'`) caused endless loading circles when it is the committed backup and then released, so it is only a last resort; `PinBackupPlayerType=true` remembers the last working Source-tier type and tries it first (never pins `autoplay`); failures lock a type out for 5 s (was 15 s); `FastAutoplayFirstTry` puts `autoplay` first if the previous break already needed it (re-probes Source tier after 5 consecutive wins). Only `autoplay` changes `platform` (to `android`); all others use `web`. `thunderdome`, `ios`, `android` are NOT used by any of the three scripts (UNKNOWN whether they work).

### 4.2 Algorithm (P: processM3U8, ~l.485-560)
On a media playlist with ad signifier:
1. Look up current variant `streamInfo.Urls[url]` (resolution, fps, codec). If absent -> "Ads will leak", return untouched.
2. For each playerType (minimal-requests shortcut: start at index 2 if a reload happened <1500 ms ago): get a token via 1.1 (cached master per type in `BackupEncodingsM3U8Cache`), build the usher URL = `https://usher.ttvnw.net/api/[v2/]channel/hls/<ch>.m3u8` + original `UsherParams`, set `sig`, `token`, fetch master (realFetch).
3. Pick the matching variant: `getStreamUrlForResolution` -> exact `RESOLUTION` match preferring equal `FRAME-RATE`; else closest by pixel-area difference. Fetch that media playlist.
4. If it has no ad signifier -> use it as the response body (`textStr = backupM3u8`). If it has ads, drop the cache for that type and try the next; the `FallbackPlayerType` text is remembered as last resort.
5. If none clean: use fallback text, then `stripAdSegments` removes ad `#EXTINF` segments (player buffers/shows loading until live segments reappear).
6. Banner "Blocking [midroll ]ads[ (stripping)]" in `.video-player > .adblock-overlay` (R hides via CSS class `.tas-adblock-overlay`).

### 4.3 Codec handling (2K/4K "enhanced" streams)
Master is rewritten at first load: HEVC (`hev*`/`hvc*`) variants get their `CODECS` and URL swapped to the nearest non-HEVC (`avc*`/`av0*`) variant (URL lines made unique by padding spaces, "the stream doesn't load unless each url line is unique"). When an ad starts on an HEVC variant, `IsUsingModifiedM3U8=true` and the player is reloaded onto the AVC master; after the ad it is reloaded back. ryanbr v68.5.0/68.5.6 extended this to AV1 (`av0`). Without it: error #4000/#3000 on Chromium.

### 4.4 All backups ad-laden (R)
Takes the last type as fallback; `stripAdSegments` + recovery path: keeps `LastCleanNativeM3U8` (snapshot of last clean main playlist) and `RecoverySegments` (last 6 live segments) and serves them when stripping empties the playlist; `BLANK_MP4` blob injected for ad segment fetches; sticky "escape hatch" after ~6 all-stripped polls (~12 s) -> try backups again including `autoplay`; early reload after 3 all-stripped polls. ttv-lol-pro equivalent: if both proxied and non-proxied streams have ads, "fallback to purple screen for prerolls" (T commit 2025-11-26).

## 5. Recovery tricks

- Reload via React internals (P: getPlayerAndState + doTwitchPlayerTask ~l.805-905): find `#root` -> `_reactRootContainer._internalRoot.current` or key starting `__reactContainer`; walk fibers for a stateNode having `setPlayerActive && props.mediaPlayerInstance` (player; `.playerInstance` if present) and one having `setSrc && setInitialPlaybackSettings` (state). Hard reload = `state.setSrc({isNewMediaPlayerInstance:true, refreshAccessToken:true}); player.play()`, then post `TriggeredPlayerReload` to workers. Soft = `player.pause(); player.play()`. Skip if `player.isPaused()`.
- When to reload: ad-end with `ReloadPlayerAfterAd=true` (hard) else pause/play; when switching to the AVC master; ryanbr: soft reload when the break stripped nothing (CSAI), 30 s reload cooldown, reload cap, drift correction `playbackRate=1.1` to catch live edge, post-break "video wedge" detector (currentTime advances but `getVideoPlaybackQuality().totalVideoFrames` not), iOS uses soft reloads only.
- Buffering monitor (P: monitorPlayerBuffering): every 600 ms compare `player.core.state.position`, `bufferedPosition`, `getBufferDuration()`; if same for 3 ticks (and not actively stripping, 8 s min repeat) -> pause/play (or reload if `PlayerBufferingDoPlayerReload`). Danger zone 1 s (R: 0.5 s).
- Tab visibility: P overrides `document.visibilityState='visible'`, `hidden=false`, blocks `visibilitychange`, resumes video on focus if it was playing (stops Twitch pausing during an ad in background tab). R later dropped the spoof (broke BetterTTV) and only resumes the video on focus.
- localStorage hooks (P: onContentLoaded): cache `video-quality`, `video-muted`, `volume`, `lowLatencyModeEnabled`, `persistenceEnabled` in a Map and wrap `localStorage.getItem/setItem` so a reload keeps them; if hook fails (Firefox) it saves/restores `video-quality`, `video-muted`, `volume` manually around setSrc (3 s delay). It does not set quality itself.
- Purple screen: this is Twitch's "commercial break" slate shown when no ad-free stream is available; vaft avoids it by swapping/stripping; ttv-lol-pro accepts it as the fallback (T). Preroll "Preparing your stream..." leak was fixed upstream 2025-10-08.
- Spoofing ad completion beacons (R, `DisableAdSpoofing=true` default since v68.3.0): GQL `video_ad_impression`, `video_ad_quartile_complete` x4, `video_ad_pod_complete` with RADS token from DATERANGE; turned OFF because it may fingerprint as anomalous. Do not implement.
- `twitch-stitched-ad` / `client_ad` events: only the DATERANGE `twitch-stitched-ad` class is matched; no `client_ad` string appears in any of the cloned sources (UNKNOWN as an event name).

## 6. TTV LOL PRO proxy approach (GPL-3.0)

- Mechanism: Chromium `chrome.proxy.settings.set` with a PAC script `FindProxyForURL` (T: common/ts/proxySettings.ts l.60-95) returning the proxy for hosts matching: `passport.twitch.tv`, `usher.ttvnw.net`, video-weaver hosts (`*.playlist.live-video.net`, `*.playlist.ttvnw.net`, `video-weaver.*.hls.ttvnw.net`), `gql.twitch.tv`, `www|m.twitch.tv`, each gated by `isRequestTypeProxied(type, params)` and the user's "passport level" (default `passportLevel: 0` = only usher + video-weaver proxied; level 1 adds token GQL + passport; 2 adds integrity). Firefox uses `proxy.onRequest` (background/handlers/onProxyRequest.ts). Default proxies (optimized): `chromium.api.cdn-perfprod.com:2023` / `firefox.api.cdn-perfprod.com:2023` (CHECKED, store/getDefaultState.ts).
- Why it works (REPORTED, README+code): Twitch decides ad insertion server-side per requesting IP/region at the usher/video-weaver. Requests from a proxy in an ad-less country ("USER-COUNTRY" in usher response) return playlists without stitched ads. Page script also detects `"stitched-ad"` in weaver responses and, if found, asks for a replacement usher URL (ad replacement; limits to 1 attempt, then purple-screen fallback) (T getFetch.ts l.738-800).
- Page side: `content_scripts` MAIN world `page/page.ts` replaces `window.fetch` and `window.Worker` (reverting fetch if Worker replacement fails or another blocker present), content script passes params via `document.documentElement.dataset.tlpParams` + a random-named `BroadcastChannel` (`TLP_<random>`) to talk page <-> content <-> worker.
- Pros: ads removed at source, no segment stripping, no reloads, quality kept; least playback glitching ("Proxies are the most reliable", pixeltris README).
- Cons: needs a third-party proxy (privacy, latency, downtime, README "proxy issues"); proxy needs `proxy`, `webRequest`, `webRequestAuthProvider` permissions (scary on the Chrome Web Store); proxying all Twitch traffic is rejected by some policy reviewers; flagged requests / IPs get ads anyway; does not remove banner/CSAI ads; breaks if proxy gets blocked. Not self-contained.
- DNR use: `rulesets/ruleset.json` has two block rules: `*.twitch.tv/r/s/*` (script) and `*.twitch.tv/r/c/*` (image) (CHECKED) -- Twitch's anti-adblock/ad tracking paths.

## 7. MV3 constraints

- Manifest pattern (CHECKED in ttv-lol-pro manifest.chromium.json): `"content_scripts":[{"matches":["https://www.twitch.tv/*","https://m.twitch.tv/*"],"js":["page/page.ts"],"run_at":"document_start","world":"MAIN"}]`; min Chrome 111 (MAIN world content scripts). Permissions: `declarativeNetRequest`, `storage`; host_permissions `https://*.twitch.tv/*`, `https://*.ttvnw.net/*`, `https://*.live-video.net/*` only needed if the extension itself fetches; page-context fetches need none.
- Recommended: two content scripts: (1) MAIN world, document_start, `matches: ["*://*.twitch.tv/*"]`, `all_frames: true`, with the whole hook code (it must run before Twitch creates the worker; nested frames other than `player.twitch.tv`/`embed.twitch.tv`/`/embed/` should bail out as ryanbr does; also exclude `clips.twitch.tv`); (2) optional ISOLATED world script only for options/storage, passing config via a data attribute or `BroadcastChannel`/`postMessage` (MAIN world has no `chrome.*`). Config must be available synchronously at start (hard-code defaults, update later by message).
- The hook script is bundled with the extension (no remote code, MV3 OK). The worker blob is built from strings of our own bundled functions + Twitch's own fetched worker source (sync XHR) -- no `eval` of remote code; but `eval(workerString)` is used in P; ttv-lol-pro avoids eval via `importScripts` of the extension URL (needs `web_accessible_resources` / or inlined into blob). Using inline function.toString() avoids WAR.
- CSP: Twitch allows `blob:` workers (they use them); `importScripts` of a `chrome-extension://` URL from a blob worker needs the file in `web_accessible_resources` (ttv-lol-pro uses `url:` import with `use_dynamic_url`; see its manifest). UNKNOWN: whether Twitch's CSP `worker-src`/`script-src` blocks the extension URL in every case; the toString() approach sidesteps it.
- declarativeNetRequest: can only block/redirect/modify headers; cannot rewrite playlist bodies, so it cannot replace the stripping logic. Useful additions (CHECKED as existing filter lines): uBO `||amazon-adsystem.com/aax2/apstag.js$script,domain=twitch.tv,important` (uAssets filters.txt l.2704) and quick-fixes cosmetic rules hiding `video[src^="https://m.media-amazon.com"]` ad elements in chat/side (quick-fixes.txt l.511-512); TTV LOL PRO's `*.twitch.tv/r/s/*` + `/r/c/*` blocks. Blocking `edge.ads.twitch.tv` (CSAI endpoint) is NOT done by any project; effect UNKNOWN (R logs requests with `bp=midroll`/`bp=preroll` but does not block). Do not DNR-block `gql.twitch.tv`, `usher.ttvnw.net`, `*.live-video.net`, or `spade.twitch.tv` blindly: spade/countess/telemetry blocking is not used by any cloned project, so safety for playback is UNKNOWN (test before shipping).
- Service worker not needed for the core technique; everything runs in the page.

## 8. What changed in 2025-2026 (from commits/changelogs)

pixeltris commits (CHECKED via git log): 2025-06-22..28 GQL requests failing under Chrome/Brave (spoofed header); 2025-07-20/21 muted streams / tab-switch pausing; 2025-10-08 "Fix vaft ad leakage ('Preparing your stream...')"; 2025-10-23 error 4000 fix for 2K/4K (HEVC swap) and embed pausing; 2025-11-04 v2 usher API; 2025-11-18 "Fix backup player types #471"; 2025-11-20 "Added ad stripping to vaft / video-swap-new"; 2025-11-21 mini player staying above chat; 2026-02-24 "Update player internals #499" (React fiber lookup changed -> `mediaPlayerInstance.playerInstance`), mini-player prevention; 2026-02-28 paused-start fix; 2026-03-05 archived. issues.md (CHECKED): streams appear offline when ads occur (#477), loading wheel while stripping, black screen when player reloads, vaft stutter/desync from switching m3u8s.
ryanbr changelog (REPORTED, read excerpts): from ~2026-05 "every observed channel ends every ad break with `stripped 0`": Twitch moved to CSAI (client-side ad insertion via `edge.ads.twitch.tv`, outside the m3u8) while still emitting SSAI markers in playlists; Source-tier backups no longer help, so autoplay (360p) became the practical backup; spoofing became counter-productive; `embed` GQL fails from twitch.tv; AV1 added to enhanced codecs (v68.5.0, 2026-07-23); since ~July 2026 separate ad `<video>` elements beside the player/in chat with `src` on `media-amazon.com` are hidden/muted/paused (v68.5.6, 2026-08-27, `hideTwitchAdOverlays`); fork requests to `edge.ads.twitch.tv` counted via fetch+XHR hooks (v68.5.7). ttv-lol-pro: 2025-11-26 purple-screen fallback; 2025-12-08 revert fetch hook if Worker hook fails; 2026-05-08 Chrome startup-listener workaround.

## 9. Not verified / gaps
- Live behaviour today (I did not run anything or hit Twitch).
- GitHub issue lists for each repo (API rate-limited without auth) -- only commit/changelog evidence used.
- Exact LICENSE of pixeltris/ryanbr repos beyond header.
- Effects of DNR-blocking `edge.ads.twitch.tv`, spade, countess.
- Whether `thunderdome`/`ios`/`android` playerTypes work (not used by any script).
