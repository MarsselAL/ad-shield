# YouTube "pauses when the video is opened" - research 2026-11-21

Labels: CHECKED = I opened it; REPORTED = a source says so; INFERRED = my reasoning. `gh` CLI was not installed; GitHub was read through the public REST API and raw.githubusercontent.com (rate-limited, so some commit diffs could not be opened).

## Bottom line
No source (uBO, AdGuard, Brave, userscripts) was found saying that the oaeb/yahi `params`/`pp` trick makes a video start paused. The cause is therefore INFERRED, not confirmed. Ranked suspects are in the section "Suspects in our code".

## What uBO does now (CHECKED, filters/quick-fixes.txt on master, 2026-11-21)
Source: https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt (lines 25-31, 55)
- Line 25: a `rpnt` script patch in the page (serverContract). It sets a tag list `["channel","yahi","inline","oaeb"]` (embed: `["channel","eafg"]`). The tag is written into `ytcfg.data_.INNERTUBE_CONTEXT.client.userAgent` as "; <tag>". Only the FIRST tag ("channel") is used at first.
  - It detects fake buffering (buffer_health 0.00 s, resolution 0x0, after an `onSnackbarMessage` Map.has hit or a 104/105-byte Uint8Array push), then moves to the next tag and calls `player.loadVideoById(id, start)` = a player reload per tag. The working tag is kept for the next videos.
  - If the response is UNPLAYABLE with support answer 3037019 it also drops to the next tag.
  - It seeks to the end of an SSAP ad (`debug_info` starts with "SSAP, AD").
  - It also still stubs `onAbnormalityDetected` through a `Promise.prototype.then` proxy.
- Lines 26-29: `trusted-edit-inbound-object, JSON.stringify` adds `{"clientScreen":"CHANNEL"}` / `{"params":"YAHI"}` / `{"isInlinePlaybackNoAd":true}` / `{"params":"oAEBogYBLg"}` to the /player body when `attestationRequest` exists and userAgent contains the tag.
- Line 30: referer gets `#reloadxhr` appended for tagged requests.
- Line 55: `nano-stb, [native code], 17000, 0.001`.
- Lines 60-81: json-prune of adPlacements/adSlots etc. (fetch, xhr), `rpfr` "no_ads".
- uBO never edits the watch-page URL and never uses a `pp` URL param (grep of quick-fixes.txt for `pp=` found nothing). The `pp` redirect (our rules/youtube.json rule 3) is our own invention. INFERRED/CHECKED by grep.
- oaeb was added in commit dcf5811 (2026-11-14, "update #30157"); other recent quick-fixes commits: 1fbf62c (11-17), many "upd AdguardFilters/issues/245421" (11-13..11-21). Commit list: https://github.com/uBlockOrigin/uAssets/commits/master/filters/quick-fixes.txt
- Official thread: https://github.com/uBlockOrigin/uAssets/issues/30157 (open, updated 2026-11-21). First post: fake buffering = "4-24 sec delay before playing"; asks users to enable the "uBlock filters - Experimental" list. Comment 2026-11-21 (stephenhawk8054, https://github.com/uBlockOrigin/uAssets/issues/30157#issuecomment-7053741545): uBO tries a list of methods, reloading the player for each, and the working one is then applied to later videos (the player reloads once). Of the ~91 comments since 2026-11-10 I found none about "starts paused" or about oaeb side effects (keyword scan on pause/oaeb/yahi/autoplay/pp=/stuck/reloadxhr/black/0x0; only hit: black screen on /embed/ 5-15 s, https://github.com/uBlockOrigin/uAssets/issues/30157#issuecomment-6895010711).

## AdGuard / others (last ~4 weeks)
- AdguardFilters search "youtube pause" since 2026-10-20: only issue #246295 (playlist repeat resets; bot found it also happens without AdGuard) and a batch of reports on the same thread (iPad stuck buffering, "an error occurred"). Nothing about start-paused. https://github.com/AdguardTeam/AdguardFilters/issues/246295 (CHECKED)
- No gorhill/uBlock or uAssets issue created after 2026-10-20 matching "paused" (search returned empty) (CHECKED, search limited).
- https://github.com/MartinPTielemans/ilo/issues/3272 (CHECKED): a CI harness for adblockers sees, even with uBO alone, "video 0.0 paused, autoplay refused" in the first seconds on a fresh watch page, until the harness presses `k`. So "Chrome refused autoplay; video cued/paused" happens with uBO too in automation (no user gesture). It does not involve oaeb.
- Firefox add-on "YouTube auto pause preventer" exists for ad-blocker pauses (REPORTED, search snippet only, not opened).
- Not found: any Brave, RemoveAdblockThing or userscript change in Nov 2026 about start-paused. UNKNOWN whether any exists.

## Params decoded (CHECKED, my own base64 decode)
- `oAEBogYBLg` = bytes a0 01 01 a2 06 01 2e: field 20 varint 1 and field 100 string ".". `YAHI` = 60 01 c8. `8AEB` = f0 01 01 (field 30 = 1; Invidious uses 8AEB "for getting youtube stories", REPORTED, not opened).
- Meaning of oaeb fields: UNKNOWN. A `set` of `params` REPLACES whatever params the page sent (e.g. in-page navigation params). uBO does the same only when its tag is active.

## Suspects in our code (INFERRED, ranked)
1. rules/youtube.json:4 (pp redirect on every www.youtube.com/watch main_frame load) together with :5. It changes the first, server-rendered player response for EVERY direct load, also when there is no fake buffering. uBO does not do this and uses oaeb only as its 4th fallback tag after a reload. If YouTube's server returns a player response with different playbackStartConfig/autoplay behaviour for these `pp` bits, the player would be cued. Test: disable rule 3 only and open 5 direct watch URLs.
2. rules/scriptlets.json edit-request-body rules (the two entries on /player and get_watch; code src/scriptlets/lib.js `editRequestBody` ~line 520-640, `applyEdits` sets, not merges): `params` replaced wholesale on every /player and every in-page get_watch. Overwrites any params the client set. In-page click-to-play (SPA) would then get the same cued state. Test: remove only the get_watch entry, then only the /player entry.
3. Chrome autoplay policy / harness masking: tools/youtube_test.py:195-204 clicks the player and calls play() when paused at i=5/15 and line 84 calls `v.play()`, so the 3x60 s test that reported "stall 0-2 s" cannot show a start-paused video. Run once with those nudges off and log `readyState`, `paused`, `player.getPlayerState()` (-1 unstarted / 5 cued) at 0-10 s.
4. Low: youtubeEnforcementDismiss (lib.js ~914-1090) only calls play() (resume), never pause(); the 17 s setTimeout cut (scriptlets.json adjust-setTimeout) mirrors uBO line 55.
- Not a likely cause: json-prune of ad keys (same as uBO), the DNR block rules 1-2.

## Recommended fix
1. Bisect first (cheap): drop DNR rule 3 (+500001), re-test manual open and click-from-home; then the get_watch/ /player edit.
2. Prefer uBO's order of operations: normal request first; apply oaeb only after fake-buffering is detected (0x0 and buffer_health 0.00 s) and then `loadVideoById(id, start)` once, keep the choice for later videos. Costs a reload on affected videos but avoids altering every load.
3. If keeping always-on oaeb, do not use `pp` in the URL; keep only the request-body edit and measure start state without nudges.
4. Make youtube_test.py record "started paused" (state -1/5 at 3 s) without calling play().

## Still unknown
Whether `pp=oAEBogYBLg` or body `params` changes autoplay (no source); the user's browser/profile/Chrome version; whether the pause is in-page navigation or direct load; Brave/AdGuard userscript behaviour for this.
