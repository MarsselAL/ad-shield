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

## Not changed

EasyList DNR, cosmetic CSS, cookie banners, element picker, popup, options, list updates.

## Risks

- Twitch changes player-type rules often (vaft #450, #471); popout/embed may start carrying ads,
  then 2.0 strips and the viewer sees a loading spinner during the break instead of a blurry
  backup. That is the chosen trade-off.
- Removing the onAbnormalityDetected and web_streaming_watch rules may bring back enforcement on
  some accounts; uBO dropped them without that happening, per research-v3.
