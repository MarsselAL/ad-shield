# Research v3 (2026-11-19): Twitch and YouTube video-ad blocking

Why: Ad Shield shows Twitch freezes and blur, and YouTube FPS dips in 1.1.5. This file condenses the research into the repo. The source notes live outside the repo, in `/Users/Marsel/Library/Application Support/Claude/side-session-notes/local_89f92288-56b2-4e77-a01a-fb8abb425e4f/` (research-vaft.md, research-twitch-others.md, research-youtube.md).

Labels: CHECKED = the source was opened. REPORTED = a secondary source (issue, README, review, search snippet). INFERRED = engineering judgement, no report found. UNKNOWN = not found.

Limits: the GitHub API rate limit was hit during the Twitch run, so some issue lists came from summaries. wiki.ttvlolpro.com redirected to a GitBook host that was not read. Reddit was not reachable, only search snippets.

## Twitch

### Technique comparison

| Project | Technique | How it avoids freezes / quality drops / desync | Known failure modes | Works now? |
|---|---|---|---|---|
| vaft (pixeltris) | Worker hook; blanks ad segments in the playlist; swaps in an ad-free backup playlist from other player types; reloads the player after each ad (CHECKED) | Not solved. A watchdog pauses and resumes the player when stuck (CHECKED) | Freezes, repeating segments, A/V desync (#476, #492); black screen during stripping (#481); ads returned (#497) | No. Repo archived 2026-03-05 (CHECKED) |
| video-swap-new (pixeltris) | Same family as vaft; ad tag `stitched-ad`; default player types autoplay, picture-by-picture, embed (CHECKED, defaults only) | UNKNOWN, not researched beyond the defaults | UNKNOWN | UNKNOWN |
| Purple (arthurbolsoni) | Worker constructor replaced; on an ad, the same stream is fetched under other player types and the first clean one is served; ad segments replaced with live segments from the same moment (CHECKED README) | Renumbers backups to the live media sequence; restarts the player once per break (about 1 s); preroll plays a clean autoplay stream | Off-by-one A/V desync (#112, fixed in 2.7.1, more fixes in 2.7.3); freezes and desync still reported on some channels (2026-11-15) | Yes, v2.7.3 (2026-11-09), with desync on some channels |
| TTV AB (GosuDRM) | Validates playlists; keeps a verified ad-free backup live; rotates away from stalled sources; continues from the live position; returns to native after clean checks (CHECKED README) | Low Quality Fallback (default on): clean 360p bridge first, HD replacement later; freeze fix skips buffer holes up to 2.5 s; avoids pause/resume when quality matches (CHECKED) | Stream came back with only 360p and 160p after picture-by-picture loaded first; fixed by keeping the full quality list (CHECKED changelog) | Yes, v27.0.1 (2026-11-19); Chromium only, not iOS or WebKit |
| TTV LOL PRO (younesaassila) | Browser proxy in an ad-free country routes Passport, Usher, VideoWeaver playlists and the GQL token request (CHECKED, v2 branch); segments are never proxied | Ads avoided at the source: no segment surgery, real stream quality | Depends on proxies; Twitch IP checks on media playlists (#443, v1 affected, v2 handles it); "both streams contain ads" (#428); black screen (#429); endless buffering (#432, duplicate of #426) | Yes for many users, intermittent (CHECKED issues) |
| uBlock Origin | Network and cosmetic rules only; no in-stream playlist logic (CHECKED). vaft is loaded as a user resource | Does not touch SSAI | Official page: Twitch video ads "not reliably blocked" (CHECKED) | Partially, unreliable |
| uBO Lite | MV3, declarative only; no scripts, so no worker hook or playlist rewriting (CHECKED #30158; blogs REPORTED) | Cannot do playlist work | Cannot block SSAI | Partially, unreliable |
| AdGuard Extra | Userscript or extension; technique UNKNOWN, script not located in repo. Shows a "Blocking ads" indicator (REPORTED) | Quality drops during ads reported (#659, closed, not reproduced); a backup-stream swap is INFERRED | Audio desync at 1440p (#664, fixed in beta 1.1.37, CHECKED); corner and banner ads (#665, back 2026-11-07) | Mostly, with audio and quality caveats |
| Alternate Player for Twitch.tv (CoolCmd, closed source) | Own HLS player; plays a low-res stream during ads (REPORTED, reviews and pixeltris README) | UNKNOWN beyond this | Reviews: no encrypted streams, 1440p issues, watch streaks not working; embedded streamer ads still shown | UNKNOWN (listing version 2026.6.21, REPORTED) |

### vaft mechanics (CHECKED, vaft.user.js, line refs)

- Worker hook (L121-232): `window.Worker` is replaced by a subclass that strips other scripts' Twitch Worker wrappers. Twitch blob workers are rebuilt with vaft's own functions plus the original worker code (fetched by sync XHR), then evaluated.
- Worker fetch (L243): ad segment URLs return a tiny blank `data:video/mp4` segment; m3u8 responses go through `processM3U8`; usher responses are parsed per variant and cached.
- Detection (L464): playlist contains `stitched`; midroll is found from DATERANGE CLASS `MIDROLL`; an `#EXTINF` line without `,live` is an ad segment.
- Neutering, not deleting: ad segment URLs are cached for 120 s and served blank; prefetch tags are blanked; ad tracking URLs are rewritten. Lines are not removed.
- Backups (L523, L635): GQL `PlaybackAccessToken` is fetched on the main thread, then the usher URL is built for types embed, popout and autoplay (360p). Fallback is embed.
- Variant choice (L433): exact RESOLUTION match, preferring the same FRAME-RATE; otherwise the closest pixel area.
- No clean backup: the embed playlist is used with its ad segments blanked, so the player shows "Preparing your stream" or black.
- Main-thread hook: `PlaybackAccessToken` playerType is rewritten to popout; picture-by-picture token bodies are blanked.
- Player touching (L803, L847): React fiber lookup; `pause()`/`play()`; a `setSrc` reload at every ad end (`ReloadPlayerAfterAd`, default true). No seeking.
- Watchdog: polls every 600 ms; stuck after 3 polls with no position or buffer change; pause/play; minimum repeat 8000 ms (lowered from 12000 in Feb 2026).
- Quality and settings: `localStorage` get/setItem hooked so quality, mute and volume survive reloads; `document.hidden` and `visibilityState` spoofed so background tabs do not pause.
- HEVC: HEVC variants are swapped to the nearest AVC URL with a forced reload. The dummy ad segment carries its own moov; there is no EXT-X-MAP handling in vaft.
- Defaults (declareOptions, L23): backup types embed, popout, autoplay (picture-by-picture commented out); fallback embed; force access token popout.

### vaft issue history (CHECKED issue reads unless marked)

- #450 (2025-10-08): low-res autoplay and pip stopped working; fix in 53c1832 and 7240e98 falls back to embed, which gives a "Preparing your stream" screen that is prone to freezing.
- #461 (2025-11-04) and #471 (2025-11-14): ads back, midroll leaks, "commercial break in progress". Fix 8d37319 (2025-11-18, #472) makes requests look genuine.
- #476 (2025-11-19): freezing, buffering, repeating segments and audio desync recorded as an unsolved root cause. Final word: watchdog plus settings.
- #479 (2025-11-20): muted after an ad or reload, from localStorage mute and volume restore. Workaround: disable reloads.
- #480: ad UI or mini player stays after the block; fixed in 233bedd and 91d8325.
- #481: black screen for about 30 s while stripping at stream load.
- #477 (open): streams appear "offline" when ads occur; cause unknown.
- #485: asks whether the stream restarts periodically. Yes, through ReloadPlayerAfterAd.
- #492 (2025-12-24): endless buffering after raids and ads. The watchdog's position>5 check blocked a fix. Later reports: about 5 pause/plays per ad, A/V desync after about 2 ad breaks (v35), manual pause/play resyncs.
- #493 (open): "Failed to load module" core-error overlay. #495 and #497: Greasemonkey incompatible; midroll buffering (2026-02). #506 (open, 2026-03): black overlay.
- uBO injection is flaky (#200). Issue-body claims about tokens are REPORTED only.

### What works / what does not

Works:
- Proxy-based avoidance (TTV LOL PRO): no stitched ads, no segment surgery, real quality (CHECKED source; works for many users, REPORTED).
- Playlist swap from other player types, renumbered to the live media sequence (Purple) (CHECKED).
- Keeping the full quality list, and skipping pause/resume when codec and quality match (TTV AB) (CHECKED changelog).
- Picking backups that match the current variant (vaft, Purple) (CHECKED).
- A rate-limited watchdog as a last resort (vaft), which helps some users (REPORTED in issues).

Does not:
- Blanking or stripping ad segments alone: stalls and black screens. The vaft maintainer says it "breaks sequencing and causes freezing" (#404, CHECKED).
- Off-by-one media sequence: A/V desync; a picture 2 s behind per midroll (Purple #112, CHECKED).
- Repeated pause/play and reloads: endless buffering (vaft #492). An immediate reload made things worse; a 60 s delay helped (REPORTED).
- Low-res backups: 360p or 160p quality (TTV AB; AdGuard workaround in #664).
- Twitch validating low-res player types since about Nov 2025, which broke the autoplay and picture-by-picture backups (vaft #450, #471, CHECKED).
- uBO and uBO Lite network rules alone: no SSAI blocking (CHECKED).
- TTV LOL PRO v1 with IP checks on media playlists (#443, CHECKED).

## YouTube

### What uBO and AdGuard ship today

Status as of 2026-11-19. uBO from quick-fixes.txt and filters.txt (CHECKED); AdGuard from BaseFilter/sections/specific.txt (CHECKED).

| Rule | uBO status | AdGuard status |
|---|---|---|
| Prune `adPlacements`, `adSlots`, `playerAds` on `ytInitialPlayerResponse` (set-constant or json-prune) | Active, www, m, music, tv, kids, nocookie | Active (set-constant on `ytInitialPlayerResponse` and `playerResponse.adPlacements`) |
| json-prune-fetch / xhr-response on `/youtubei/v1/player`, `get_watch`, `playlist`, `resolve_url` with propsToMatch | Active (quick-fixes) | Active on `/playlist?list=`, `player?`, `watch?[tv]=`, `get_watch?` |
| Network `$xhr,replace=` turning `adPlacements` / `adSlots` into `no_ads` | Active where HTML filtering is available | Not found in notes |
| `nano-stb`: adjust-setTimeout `[native code]`, delay 17000, factor 0.001 | Active, www only | Active, same arguments |
| `onAbnormalityDetected` callback neutering | Script-replace rule disabled (commented out); `serverContract` script active | Active: a `Promise.prototype.then` Proxy that replaces the callback with a noop |
| Request tagging via `JSON.stringify` (trusted-edit-inbound-object) for ad-free InnerTube context | Active (needs trusted list) | Active: userAgent and client_screen tagging (CHANNEL, eAFgAQ, YAHI) |
| `EXPERIMENT_FLAGS.web_streaming_watch=false` | Disabled (commented out) | UNKNOWN |
| "Video player is unavailable" error hiding | Disabled (commented out) | UNKNOWN |
| SSAP `ssapConfig` prune | `serverContract` script active instead | Present but commented out |
| Reel ads `json-prune` (`reelWatchEndpoint.adClientParams.isAd`) | Active | Not found in notes |

uBO pinned issues: uBlockOrigin/uAssets #30157 (uBO) and #30158 (uBO Lite); older #27415 and #20586 (closed, Mar 2025).

uBO Lite (CHECKED #30158 via fetch): no scripting beyond declarative and scriptlet rulesets; users are told to set YouTube to "Optimal" mode. Known problems: some members-only livestreams error, playlists skip endlessly, and some streams stick in endless buffering. A fix is expected in uBOL 2026.1116.1650 or later. Fake buffering lasts 4-24 s and depends on the account; maintainers suggest the "uBlock filters - Experimental" list.

### Anti-adblock tactics 2025-2026 and countermeasures

- Fake buffering (CHECKED, iter.ca): SABR backoff on the first `/videoplayback` for the content, set to 80% of the ad duration. Countermeasure: tag the InnerTube request as ad-free by editing `JSON.stringify` on `contentPlaybackContext`. uBO ships this, trusted-only. Cold loads use the embedded `ytInitialPlayerResponse`. If a locker script freezes `JSON.stringify`, the fallback hooks `Object.assign`.
- Stitched ads (SSAP): the ad is part of the stream and is not fully blockable server-side (AdGuard blog, CHECKED). Countermeasure: uBO's `serverContract` script detects "SSAP, AD" in `getStatsForNerds` and reloads with `loadVideoById` or `seekTo`.
- Enforcement "Video player is unavailable" (support.google.com/youtube/answer/3037019): uBO removes the player-unavailable attribute and hides the error, but that rule is disabled today. Request tagging helps (CHECKED).
- `onAbnormalityDetected`: AdGuard's Promise.then proxy neuters the callback. uBO's HTML-filter replacement is commented out. Neither is active in uBO (CHECKED).
- Black screen and endless spinner: reported in the uBO Lite thread (CHECKED #30158).
- Slow-loading diagnostics listed in #20586, "at your own risk": nano-stb tweak, `web_enable_ab_rsp_cl=false`, `ab_pl_man=false`, blocking googlevideo `videoplayback` xhr from third parties (CHECKED, no results given).

### Countermeasures likely to cause stutter (INFERRED, not measured)

No primary issue report names a specific scriptlet as the cause of frame drops or A/V desync. The searches found none (CHECKED). Related facts: the Jan 2024 YouTube slowdown was traced to Adblock Plus, not uBO; uBO's scripts used about 1% CPU vs over 20% for ABP (REPORTED, windowsreport and uBlock-issues #2218). Everything below is inferred from mechanism and needs A/B profiling.

- Promise.prototype.then proxy calling `toString()` on every callback. Highest risk: YouTube and Polymer create thousands of promises per second. uBO does not use it.
- JSON.parse hook walking large watch-next and browse payloads. Cost scales with payload size.
- Function.prototype.toString proxy: every call goes through JS.
- Timer matcher: check the exact delay (17000) before any `toString`.
- Document-wide MutationObserver: constant CPU on YouTube's churny DOM. Use CSS, a narrowed observer, or disconnect after DOMContentLoaded.
- playbackRate acceleration on ads: audio glitches and buffer starvation.
- Seeking to skip an ad: a real decode flush, so a short stall and A/V resync. Unavoidable; do it once, only in a confirmed ad state, not near content start.

Recommendation from the note (mirrors uBO):
- Keep: narrow prune paths on `ytInitialPlayerResponse`; json-prune on `/youtubei/v1/player`, `get_watch`, `playlist`, `resolve_url` with propsToMatch (no global `Response.json` hook); the exact-delay timer filter; CSS or attribute removal for enforcement errors; one-shot ad skip as a safety net; optionally the request tagging (needs care).
- Drop or avoid: the global Promise.then proxy; the `web_streaming_watch=false` flag; the toString proxy unless detection needs it; JSON.parse hooks for everything; document-wide observers; playbackRate tricks.
- Unknown: whether our stutter comes from any one of these. Needs a Chrome Performance trace with each hook dropped in turn.

### SponsorBlock skip technique (CHECKED, src/content.ts)

- Schedules the skip with `setTimeout` about 150 ms before the segment on Chromium; switches to `setInterval(..., 0)` only in the last 300 ms.
- Uses a virtual time estimate based on `performance.now`, with playbackRate in the delay math.
- Seeks with `video.currentTime` directly, not the player's `seekTo`.
- On Chromium, sets `muted = true` then `muted = false` before the skip for a clean audio cut.
- Listens to `timeupdate`, `seeked` and `ratechange`.
- Skips are one-shot, with guards for loop and end of video.
- Lesson: one precise seek, scheduled slightly early, with no long polling.

## Sources

Deduplicated. Entries given only as repo or issue names were stated that way in the notes; no URLs were added.

- https://github.com/pixeltris/TwitchAdSolutions (README, issues.md, archived 2026-03-05)
- pixeltris/TwitchAdSolutions: vaft/vaft.user.js, vaft/vaft-ublock-origin.js, video-swap-new/video-swap-new.user.js (raw master)
- https://github.com/younesaassila/ttv-lol-pro
- https://github.com/arthurbolsoni/Purple-adblock
- https://github.com/GosuDRM/TTV-AB (Chrome Web Store listing, no link in notes)
- Alternate Player for Twitch.tv: Firefox AMO listing (no link in notes)
- https://ublockorigin.com/
- https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt
- uBlockOrigin/uAssets filters/filters.txt (master); issues #30157, #30158, #20586, #27415, #5184, #662, #665
- https://adguard.com/en/article/how-to-block-twitch-ads.html
- https://github.com/AdguardTeam/AdGuardExtra
- AdguardTeam/AdguardFilters, BaseFilter/sections/specific.txt
- https://adguard.com/en/blog/youtube-server-side-ad-insertion.html
- https://iter.ca/post/yt-adblock/
- https://support.google.com/youtube/answer/3037019
- https://github.com/ajayyy/SponsorBlock/blob/master/src/content.ts
- https://windowsreport.com/ublock-origin-developer-unravels-youtubes-slowdown-with-content-blockers/
- https://github.com/uBlockOrigin/uBlock-issues/issues/2218
- wiki.ttvlolpro.com (redirected to a GitBook host, not read)
- Forks of vaft, REPORTED via GitHub search, not evaluated: ryanbr/TwitchAdSolutions, Helli24/TwitchAdSolutions, 0rpi/twitch-adblock-userscript, scamorza/TwitchAdBlock, Nyxia-Code/Twitch-Guard, zurarah/twitch-ad-blocker-with-vods
