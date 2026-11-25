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
   family as the variant the player chose. No 360p player types. *Reversed by default on
   2026-11-21* (Twitch "During Twitch ads" setting, see the note under Twitch): a short
   low-quality ad-free bridge beats a spinner or the ad; this rule now holds only with
   `twitchAdQuality: 'full'`.
4. **Measure.** Playback-health metrics (stalls, dropped frames, resolution, paused time) in both
   live test tools, with and without the extension.

## Twitch

Kept, because vaft and Purple converge on it: MAIN-world `Worker` subclass wrapping Twitch's blob
worker; worker `fetch` hook for usher masters and media playlists; GQL header capture and token
requests on the main thread; the page's own `site` token rewritten to `popout` (both projects);
ad detection by `stitched` markers and non-`live` `#EXTINF` titles.

| Piece | 1.1.5 | 2.0 |
|---|---|---|
| Backup player types | site, popout, mobile_web, embed, **autoplay (360p)** | embed, site, mobile_web (popout skipped: the page token already is popout), then **autoplay as a last-resort 360p bridge** (2026-11-21): used only when every other type answered with ads, never pinned, left when an HD type is clean again or native is clean for 2 polls (docs/research-2026-11-21-twitch.md §3 item 4). No picture-by-picture. **Since 2026-11-21 this is `twitchAdQuality: 'full'` only**; the default `'low'` asks the bridge types `autoplay`, `picture-by-picture` (`cfg.bridgePlayerTypes`) together with embed, site, mobile_web and serves the first clean answer of any type (see the note below). |
| Variant choice | closest match, may be lower | exact RESOLUTION (height) and codec family, else the type is skipped. Bridge / last-resort types: any resolution of the codec family (highest not above the player's). |
| No clean backup | strip ads, then **replay the last clean playlist** for up to 6 s, hold 4 s | never an empty playlist: if stripping leaves no segments, wait for the whole backup search; if nothing is clean, pass the original through (the ad plays). Otherwise strip ad segments, keep MEDIA-SEQUENCE continuous with the live sequence numbers (existing `resequence`), DISCONTINUITY at the boundaries. No replay of stale playlists. |
| Ad segment requested anyway | tiny blank answer | same (cached ad URLs, 120 s) |
| Return to native | after 2 clean polls | same; it is one switch per break end |
| Recovery (`src/page/recovery.js`) | soft kicks, gap seeks, frozen-picture detector, hard player reload, localStorage pinning | **removed**. Replaced by `src/page/health.js`: passive metrics plus one nudge |
| HEVC/AV1 | `preferAvc` filter drops them from the master when AVC exists | kept (prevents codec switches between native and backup) |
| fMP4 init segments | `EXT-X-MAP` kept per segment (1.1.3) | kept, it is required for backup segments with their own init |

### Low-quality bridge during ads (2026-11-21)

Decision: bring back the 1.x behaviour as the default, as a setting (`twitchAdQuality`, options
page "During Twitch ads"). Reason: with "never lower quality", a stitched (SSAI) break where every
HD type also carries the ad leaves a spinner or the ad itself; 1.x played a 360p ad-free stream at
once and viewers preferred that.

| `twitchAdQuality` | During a stitched ad break |
|---|---|
| `'low'` (default) | HD types (the viewer's list minus `cfg.bridgePlayerTypes` and the page token type) and the bridge types `autoplay` (360p, platform android) and `picture-by-picture` asked at once. The first clean answer of any type is served without waiting for the others (HD if both land in the same turn). On a bridge: the same bridge every poll (no flapping between bridge types) while the HD types are checked in the background; a clean HD type replaces the bridge on the next poll, at most once per break. Bridges are never pinned. Native again after 2 clean native polls. Prewarm at join: the first HD and the first bridge type. Nothing clean: strip / original as before. `ad-blocked-backup` carries `bridge: true` and the resolution. |
| `'full'` | The 2.0 behaviour above: same-resolution HD types first, autoplay only as a last resort, no picture-by-picture. |

Bridge types come from config, not from the viewer's list. Our backup usher requests go through
the worker's unhooked fetch, so `usherIgnoreSubstrings` (`picture-by-picture`, meant for the
page's own mini player) does not affect them.

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
| `edit-request-body` on the youtubei `/player` and `get_watch` requests, `pp` on watch-page loads | - | **new**: `params` oAEBogYBLg + referer `#reloadxhr` (client WEB; `/player` bodies with `attestationRequest`, `get_watch` `playerRequest`), DNR `pp=oAEBogYBLg` on `www.youtube.com/watch` | uBO's request tagging against fake buffering, without its JSON.stringify hook |

## Not changed

EasyList DNR, cosmetic CSS, cookie banners, element picker, list updates. (Popup and options were
restyled on 2026-11-25, look only: see "UI" below.)

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
- YouTube fake buffering (with Ad Shield, videos whose pre-roll was removed started after 4-16 s
  of a black 0x0 player). Cause, measured 2026-11-20 by decoding the SABR (UMP) responses: for a
  video with a pre-roll the first `videoplayback` answer carries an ad context (SABR context
  update, type 5), a snackbar message and a NEXT_REQUEST_POLICY backoff of 4,000-8,800 ms. It
  comes with and without the extension; a client that plays the ad hides the wait behind the ad,
  a client with the ad data removed shows a black player until it ends. No scriptlet causes it:
  each one switched off alone (and the `youtube` DNR rules off) still waited 4-11 s. Fix: uBO's
  "oaeb" player params (uAssets dcf5811): with `params` / `pp` oAEBogYBLg YouTube serves a player
  response without ad keys and the stream starts without the backoff (also without the
  extension). Applied where a player response is requested: `edit-request-body` on the `/player`
  body (`attestationRequest`) and on the `playerRequest` of `get_watch` (in-page navigation, which
  sends no `/player` request), inside the fetch / XHR send wrappers, not by a JSON.stringify hook
  (gzip `fetch(Request)` bodies gunzipped, edited, gzipped again); a direct watch-page load takes
  its player response from the HTML, so `rules/youtube.json` adds `pp=oAEBogYBLg` to
  `www.youtube.com/watch` page loads (the page then shows the URL without it). tools/youtube_test.py, 3
  videos x 60 s: stall 10-20 s -> 0-2 s (without the extension 0.3-0.6 s), ads 0. Not uBO's other
  tags: "channel" (clientScreen CHANNEL) made YouTube answer UNPLAYABLE (support answer 3037019),
  "yahi" (`params` YAHI) left the same backoff. No tag rotation and no video reload.
  The "Something went wrong" error after ~40-45 s of content in those headless runs is
  STREAM_PROTECTION_STATUS 3 (attestation required) and happens without the extension too; it
  inflates "paused ms" for runs that reach 40 s of content, not an Ad Shield effect.

Rejected:
- 360p "bridge" during prerolls (TTV-AB Low Quality Fallback): brings back the blur; its users report it
  sticking at low quality (#102).
- Buffer-gap seeks and blank ad segments: seeks and holes are what froze 1.1.x.
- uBO's SSAP seekTo and its fake-buffering detector (Map.has / Array.push / Promise.then proxies,
  tag rotation, loadVideoById reload): global hooks, the class removed for the FPS dips.
- YouTube embed (`serializedThirdPartyEmbedConfig`) edits and uBO's snackbar CSS (uBO itself disabled it).

## UI (popup and settings, 2026-11-25)

White "clear glass" in both colour schemes; the layout, controls and ids are unchanged. Tokens live
in `src/ui/common.css` (`:root`); before/after screenshots and a per-area summary in
`docs/ui-redesign/`.

| Token | Value | Use |
|---|---|---|
| `--font` / `--font-display` | -apple-system, BlinkMacSystemFont, "SF Pro Text" / "SF Pro Display", "Segoe UI Variable", system-ui | body / titles and numbers (tracking -0.022 to -0.035em) |
| `--fg` | `#1d1d1f` | text, both schemes |
| `--muted` | `#56575f` | secondary text: 7:1 on white, 5:1 or more on glass over the dark backdrop |
| `--accent` / `--accent-text` | `#e5222e` / `#c01a24` | fills (white text 4.6:1) / red text (6.1:1 on white) |
| `--accent-fill` | `#ea3440` to `#c81a25`, vertical | primary buttons, pay button |
| `--focus` | `#d91f2b`, 2 px ring, 2 px offset | every focusable control |
| `--panel` | white 70 % to 46 % (dark scheme: 94 % to 86 %) | popup panels, settings cards |
| `--glass-blur` / `--blur` | blur(30px) saturate(190%) / blur(22px) saturate(180%) | panels / small cards |
| `--rim` | white 100 % at the top edge fading to 22 % | 1 px specular ring (`.panel::after`, `.card::after`) |
| `--panel-shadow`, `--card-shadow` | 0.5 px hairline + two soft drop shadows | depth |
| backdrop | light: warm white + coral, red, peach, lilac blobs; dark: plum dusk + stronger blobs | the only part that changes with the scheme (plus `--on-backdrop*` for header text) |
| radii | panels 24, settings cards 24, inner cards 16-20, controls capsule (999px) | |
| `--spring` / `--spring-bouncy` | `linear()` damped springs, ~4 % / ~12 % overshoot (cubic-bezier fallback) | entrances, knobs, segmented pill, hovers |

Motion is transform / opacity only and is switched off under `prefers-reduced-motion`. `popup.js`
adds `.bump` to a stat number when its count changes (the pop animation); nothing else in the
scripts changed.
