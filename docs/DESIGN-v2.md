# Ad Shield 2.0 design (2026-11-19)

Evidence: `docs/research-v3.md`. Problems to fix: Twitch stops mid-stream and goes blurry
(1.1.x); YouTube has short FPS dips.

## Principles

1. **Do less in the hot path.** Every hook that runs on every frame, promise or JSON parse costs
   frames. Keep only hooks that the strongest projects (uBO for YouTube; vaft and Purple for
   Twitch) still ship.
2. **Never fight the player.** No seeks, no reloads, no localStorage quality writes. The only
   player action left is one gated pause/play nudge on Twitch (below).
3. **Never lower quality.** A backup playlist is used only at the same resolution and codec
   family as the variant the player chose. No 360p player types.
4. **Measure.** Playback-health metrics (stalls, dropped frames, resolution, paused time) in both
   live test tools, with and without the extension.

## Twitch

Kept, because vaft and Purple converge on it: MAIN-world `Worker` subclass wrapping Twitch's blob
worker; worker `fetch` hook for usher masters and media playlists; GQL header capture and token
requests on the main thread; the page's own `site` token rewritten to `popout` (both projects);
ad detection by `stitched` markers and non-`live` `#EXTINF` titles.

| Piece | 1.1.5 | 2.0 |
|---|---|---|
| Backup player types | site, popout, mobile_web, embed, **autoplay (360p)** | embed, site, mobile_web (popout skipped: the page token already is popout). No autoplay or picture-by-picture (360p caps; vaft #450). |
| Variant choice | closest match, may be lower | exact RESOLUTION (height) and codec family, else the type is skipped |
| No clean backup | strip ads, then **replay the last clean playlist** for up to 6 s, hold 4 s | never an empty playlist: if stripping leaves no segments, wait for the whole backup search; if nothing is clean, pass the original through (the ad plays). Otherwise strip ad segments, keep MEDIA-SEQUENCE continuous with the live sequence numbers (existing `resequence`), DISCONTINUITY at the boundaries. No replay of stale playlists. |
| Ad segment requested anyway | tiny blank answer | same (cached ad URLs, 120 s) |
| Return to native | after 2 clean polls | same; it is one switch per break end |
| Recovery (`src/page/recovery.js`) | soft kicks, gap seeks, frozen-picture detector, hard player reload, localStorage pinning | **removed**. Replaced by `src/page/health.js`: passive metrics plus one nudge |
| HEVC/AV1 | `preferAvc` filter drops them from the master when AVC exists | kept (prevents codec switches between native and backup) |
| fMP4 init segments | `EXT-X-MAP` kept per segment (1.1.3) | kept, it is required for backup segments with their own init |

### The one nudge

Maintainer evidence (vaft #476/#492): after a playlist switch the player sometimes wedges; one
pause/play clears it; repeated or early kicks make it worse. Rule: within 30 s after a source
switch, if the tab is visible, the video is not paused, the playhead has not advanced for 5 s and
at least 1 s is buffered ahead, call `pause()` then `play()` once. At most once per ad break and
once per 60 s. Never when the user paused (user gesture within 1.5 s or video paused).

### Metrics (`health.js`)

Every 2 s while a video plays (no timer when none): `currentTime` advance, `waiting` events,
`getVideoPlaybackQuality()` dropped/total frames, `videoHeight`, time paused. Exposed to the
bridge as `health` events (debug log only). The live tools sample the video element themselves
over CDP, so nothing is exposed on `window`.

## YouTube

| Rule | 1.1.5 | 2.0 | Why |
|---|---|---|---|
| `prevent-promise-then-callback onAbnormalityDetected` | on (Proxy on every `Promise.prototype.then`) | **removed** | uBO commented it out; highest stutter risk |
| `set-constant web_streaming_watch false` | on | **removed** | uBO commented it out; changes the streaming path |
| `Function.prototype.toString` proxy | always installed | **removed**; patched functions only get a non-enumerable own `toString` | global proxy cost on every `toString` |
| `json-prune` feed items (JSON.parse, `responseContext`) | on | **removed**; feed ad slots stay hidden by `youtube.css` and `ytInitialData` pruning | every big JSON.parse scanned |
| `json-prune` player keys (JSON.parse) | on | kept, needle pre-check first | uBO ships it |
| fetch/XHR prune | player, get_watch, next, browse, search, reel | player, get_watch, playlist, resolve_url, reel | uBO's URL set; fewer large bodies cloned |
| `adjust-setTimeout [native code] 17000 0.001` | on | kept; delay compared before any string work | uBO ships it |
| `prune-on-assign` ytInitialPlayerResponse / ytInitialData | on | kept | one-time |
| `youtube-ad-skip`, `youtube-enforcement-dismiss` | 1.1.5 limits | kept | fallbacks, already limited |
| `edit-request-body` on the youtubei `/player` request | - | **new**: `params` YAHI + referer `#reloadxhr` (client WEB, `attestationRequest` bodies only) | uBO's request tagging against fake buffering, without its JSON.stringify hook |

## Not changed

EasyList DNR, cosmetic CSS, cookie banners, element picker, popup, options, list updates.

## Risks

- Twitch changes player-type rules often (vaft #450, #471); popout/embed may start carrying ads,
  then 2.0 strips and the viewer sees a loading spinner during the break instead of a blurry
  backup. That is the chosen trade-off.
- Removing the onAbnormalityDetected and web_streaming_watch rules may bring back enforcement on
  some accounts; uBO dropped them without that happening, per research-v3.

## Improvement pass (2026-11-19, evening)

Sources: forum and issue-tracker scan of Sep 20 - Nov 19 2026 (Purple 2.7.x, TTV-AB changelog
up to 27.0.1, uBO quick-fixes commits). Notes outside the repo, `research-2026-11-19-*.md`.

Done:
- Twitch: `twitch-maf-ad` DATERANGE alone is a client-side ad shown beside the stream (TTV-AB #98),
  not a stitched ad: no backup search for it (`clientAdDaterangeClasses`).
- Twitch: the first backup type's token and master are fetched when the live master arrives, and an ad
  poll asks all backup types at once, serving the most preferred clean answer (Purple ec29b68 / d9cafb2).
- YouTube: prune `endpoint.watchEndpoint.unserializedPrefetchData.playerResponse` ad keys in
  resolve_url responses (uBO fed4e61, 2026-10-31).
- YouTube fake buffering (with Ad Shield, ad videos started after 4-16 s of a 0x0 player): the
  `/player` request body gets uBO's tag edit (uAssets ef0ac51 / dcf5811 / 1fbf62c), done by
  `edit-request-body` inside the fetch / XHR send wrappers, not by a JSON.stringify hook. YouTube
  sends that request as `fetch(Request)` with a gzip body, so the scriptlet reads a clone, gunzips,
  edits and gzips again (Compression/DecompressionStream). uBO's first tag, clientScreen CHANNEL,
  made YouTube answer UNPLAYABLE (support answer 3037019) in our headless runs; the "yahi" edit
  (`params` YAHI + referer `#reloadxhr`), uBO's next tag, plays. Limit: a direct watch-page load
  takes its player response from the HTML, not from `/player`, so only in-page navigation and
  reloads are edited.

Rejected:
- 360p "bridge" during prerolls (TTV-AB Low Quality Fallback): brings back the blur; its users report it
  sticking at low quality (#102).
- Buffer-gap seeks and blank ad segments: seeks and holes are what froze 1.1.x.
- uBO's SSAP seekTo and its fake-buffering detector (Map.has / Array.push / Promise.then proxies,
  tag rotation, loadVideoById reload): global hooks, the class removed for the FPS dips.
- YouTube embed (`serializedThirdPartyEmbedConfig`) edits and uBO's snackbar CSS (uBO itself disabled it).
