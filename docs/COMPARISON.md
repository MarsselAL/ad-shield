# Comparison with other Twitch ad blockers

Written 2026-11-12. Labels: CHECKED = I opened the source (our code, or the GitHub API on 2026-11-12). REPORTED = taken from `docs/research-github.md` / `docs/research-technique.md` (researched 2026-11-11), not re-verified now. UNKNOWN = not known.

Important: nobody, including us, has a test result here that proves any of these tools works today. "Maintained" is not the same as "works". Our own live results are in the last section.

## What our extension is (from our code)

- CHECKED: Manifest V3, plain JavaScript, no bundler. Permissions: `storage`, `scripting`, `declarativeNetRequest`; host permission only `*://*.twitch.tv/*` (`manifest.json`). No `proxy`, no `webRequest`.
- CHECKED: Technique. A MAIN-world content script (`document_start`) replaces `Worker` and hooks `fetch` (`src/page/page.js`). Twitch's video worker is rebuilt with our code in front (`worker-main.js`, `processor.js`, `m3u8.js`). When a media playlist has ads, the worker asks for backup streams (player types `site, popout, mobile_web, embed`, then `autoplay` 360p as last resort; `config.js`). If every backup has ads, it strips the ad segments, and serves blank answers for ad segments. The page's live token request is rewritten from `site` to `popout` (`config.js`: `forcedPlayerType`).
- CHECKED: Extras. `rules/client_ads.json` blocks `edge.ads.twitch.tv` and `apstag.js` (CSAI / ad script). `src/content/cosmetic.js` hides/mutes/pauses stand-alone ad `<video>` elements with Amazon sources. A recovery module (`recovery.js`) kicks or reloads the player after a stall, max 3 reloads per channel per 5 minutes, then strip-only mode. Optional `trackers.json` (off by default).
- CHECKED: Privacy. The service worker comment says "No polling, no alarms, no network requests". A search of `src/` found no hard-coded URL outside `config.js` (Twitch URLs only). Stats stay in `chrome.storage` (local). No remote config, no remote code, no `eval`. The only network traffic we add is requests to Twitch itself (backup tokens, backup playlists).
- CHECKED: Weak points. `overlaySelectors` (ad banner overlays) is intentionally empty (`config.js`). Twitch constants (Client-ID, persisted-query hash, markers) are hard-coded; a change needs a new release. Version is 1.0.0, license MIT.

## Project by project

### Purple-adblock (arthurbolsoni)
- Technique (REPORTED): Same family as ours. Worker hook, rewrite media playlists, backup tokens by player type, swap ad segments for live segments from backups, empty segment answers. DNR plus fetch stub for `edge.ads.twitch.tv`.
- Delivery: Chrome MV3 extension, Firefox MV2, and userscript. MV3: yes.
- Maintenance (CHECKED, GitHub API 2026-11-12): last push 2026-11-09, 509 stars, 3 open issues.
- Strengths: Active, detailed docs of Twitch behaviour (its `docs/server/` notes are our best source), tracks new Twitch changes quickly.
- Weaknesses (REPORTED): audio desync on Firefox fMP4 (#112), a preroll may need a player restart, no VOD support, single maintainer.
- Privacy: UNKNOWN in detail; I did not audit it. No proxy is described.

### GosuDRM/TTV-AB
- Technique (REPORTED): Same family. Worker hook, backup stream search, checks the backup is clean, goes back to the native stream after some clean checks. Blocks CSAI requests on VODs.
- Delivery: Chrome MV3 and Firefox extension, listed in stores. MV3: yes.
- Maintenance (CHECKED 2026-11-12): last push 2026-11-06, 131 stars, 0 open issues.
- Strengths: Active, store-listed (easy install), many fixes in Oct-Nov 2026.
- Weaknesses (REPORTED): rewinds and stream breakdowns reported in October (#81, #86, #88, #91, #96); 360p fallback is the default; it ignores the `twitch-maf-ad` marker on purpose (#98).
- Privacy: UNKNOWN; not audited.

### ryanbr/TwitchAdSolutions (vaft fork)
- Technique (REPORTED): pixeltris "vaft": worker hook, backup player-type tokens, strip ad segments, player reload. Adds CSAI handling and hides separate ad `<video>` elements. Our design follows its logic closely (our config cites it as a source).
- Delivery: Userscript, or uBO scriptlet (needs manual setup). MV3: not an extension, so not applicable; it needs a userscript manager (Chrome needs "Allow user scripts").
- Maintenance (CHECKED 2026-11-12): last push 2026-08-27, 1,133 stars, 17 open issues. REPORTED: users ask "abandoned?" (#266, 2026-10-28). Upstream pixeltris is archived (last push 2026-03-05, 11,318 stars).
- Strengths: Large user base, long history, much community knowledge.
- Weaknesses (REPORTED): freezes, audio desync (#264), clash with FrankerFaceZ, PIP bugs, rollback loop (#129), side ad player (#247/#249). Maintenance gap since August.
- Privacy: UNKNOWN in detail; no proxy needed for the main mode (the README mentions proxies as an alternative, REPORTED).

### ttv-lol-pro (younesaassila)
- Technique (REPORTED): Sends only the usher (master playlist) request through third-party HTTP proxies, so Twitch serves a playlist without ads. Permissions `proxy`, `declarativeNetRequest`, `webRequest`.
- Delivery: Chrome MV3 extension, Firefox MV2. MV3: yes.
- Maintenance (CHECKED 2026-11-12): last push 2026-11-11, 1,890 stars, 25 open issues.
- Strengths: Ads removed at the source, so usually no segment stripping or player reloads. Keeps full quality. Large user base.
- Weaknesses (REPORTED): depends on proxy servers (uptime, exit IP blocked, 403 in #392), black screen / error 2000 (#426), ads with own proxy (#441), buffering when the proxy is far away. Does not remove banner or side-video ads (README says use uBO).
- Privacy: Worst of the group. Your Twitch request traffic for the proxied hosts goes through someone else's server (default proxies at `cdn-perfprod.com`, CHECKED in research-technique.md §6). At the default level only usher and video-weaver hosts are proxied; higher "passport levels" add token/login requests. No telemetry was found in the research, but I did not audit the code myself.

### uBlock Origin (uBO)
- Without scriptlets (REPORTED): Only static filters. Cosmetic filters can hide side/chat ad `<video>` elements (uAssets commit 11edaf1, 2026-07-19). Cannot stop server-side ads stitched into the video, because they come from the same host as the stream. Only `edge.ads.twitch.tv` can be blocked by URL.
- With the vaft / twitch-videoad scriptlet (REPORTED): uBO master has no Twitch scriptlet; users load the vaft file themselves through `userResourcesLocation`. Same technique and weaknesses as vaft; "randomly stops being applied" (#200); on Firefox it was "no longer useable" for months (#129), partly fixed in v68.5.0.
- Delivery: Browser extension plus filter lists / user resources. MV3: uBO itself is MV2 on Chrome-based browsers; the MV3 version "uBO Lite" has no custom scriptlets (REPORTED general knowledge, not checked now). So the scriptlet route mostly works on Firefox, or on Chrome-family browsers that still allow MV2.
- Maintenance: uAssets quick-fixes active in 2026-07; the scriptlet file is the ryanbr one above.
- Strengths: Trusted, huge user base, also blocks everything else.
- Weaknesses: The Twitch part is manual, fragile, and needs the user to know how to set it up.
- Privacy: Good (local), the scriptlet file is a file you choose to load. No proxy.

## Summary table

| | Ours | Purple | TTV-AB | ryanbr vaft | ttv-lol-pro | uBO (+scriptlet) |
|---|---|---|---|---|---|
| Technique | worker hook + backups + strip | same | same | same | proxy for usher | filters (+ vaft) |
| Delivery | extension | extension + userscript | extension | userscript / scriptlet | extension | extension |
| MV3 | yes | yes (Chrome) | yes | n/a | yes | no on Chrome (MV2) |
| Last activity | none yet (new, v1.0.0) | 2026-11-09 | 2026-11-06 | 2026-08-27 | 2026-11-11 | n/a |
| Proxy | no | no | no | no (optional mention) | yes, 3rd party | no |
| Remote config | no | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | filter list updates |
| Telemetry | none in code | UNKNOWN | UNKNOWN | UNKNOWN | none found (not audited) | none |

## Where ours is better / worse / same

| Topic | Verdict | Notes |
|---|---|---|
| Privacy: no proxy | Better than ttv-lol-pro | Nothing leaves your browser except requests to Twitch. Permissions are small (no `proxy`, no `webRequest`). |
| Privacy: no remote config or remote code | Better for trust, worse for speed of repair | Matches the other worker-hook tools as far as I know (UNKNOWN: they may fetch config). The cost is below. |
| Reacting to Twitch changes | Worse | Client-ID, persisted-query hash, markers are in `config.js`. If Twitch changes them, users need a new release (the store review delay applies). A proxy or remote-config tool can change faster. |
| Track record | Worse | New, version 1.0.0, one author team, no user base, no public issue history. Purple, TTV-AB, ttv-lol-pro and vaft have months or years of real-world feedback. |
| Proven to work today | UNKNOWN | See Live results. The others are also only "probably" working (README research). |
| Core ad technique | Same | Same family as Purple, TTV-AB, vaft. Same known risks: freezes, desync, black screen when all backups have ads. |
| Video quality | Same or slightly worse | `preferAvc` (default on) removes HEVC/AV1 variants, so 1440p/4K "enhanced" streams are lost (`ARCHITECTURE.md`). vaft keeps them with a more complex swap. ttv-lol-pro keeps full quality. |
| Stall recovery with limits | Better (by design) | Hard reload cap (3 per 5 min per channel) then strip-only; avoids reload loops that users report for vaft (#129). Not yet proven in real use. |
| Side / chat ad videos | Same | Cosmetic hide/mute/pause, as ryanbr does. Selectors are by Amazon source host; Twitch can change that. |
| Banner / overlay ads | Worse | `overlaySelectors` is empty. uBO cosmetic lists cover some of this. |
| CSAI (`edge.ads.twitch.tv`) | Same as Purple | DNR block rule. Research notes the effect of blocking was unknown for most projects (research-technique.md §7). |
| Scope | Narrower on purpose | Live streams only on the main player; embeds, VODs, mini player are left alone (tokens not rewritten). VOD gets detect and strip only. Purple has no VOD either. |
| Install | Better than userscripts, same as Purple/TTV-AB | Plain extension; no userscript manager. Store listing: not checked. |
| Firefox | Worse | Our manifest is Chrome-focused (`minimum_chrome_version: 120`). Purple and TTV-AB support Firefox. |
| Maintenance | Worse today | Others have commits within the last week (Purple, TTV-AB, ttv-lol-pro). We have no history. |

## Honest limits of this comparison

- I did not run or download any third-party code. Technique and weakness details for others come from the earlier research (2026-11-11), not from reading their code now.
- Privacy of Purple, TTV-AB and ryanbr (remote config, telemetry) was not audited: UNKNOWN.
- uBO Lite / MV2 status is general knowledge, not checked today.
- Star counts and push dates were read from the GitHub API on 2026-11-12. A "push" is not always a code release.

## Live results

Status 2026-11-12. A long, logged-in comparison with and without the extension is still missing.

- Harness run (logged-out, hasanabi, 2 min plus quality, refresh, channel switch): video played, 0 extension errors. Twitch served no ad (0 of 160 playlists), so ad blocking was not reproduced there.
- Owner's real Chrome (logged in, 7TV): the "Ad blocked – using backup stream" toast appeared and video kept playing for about 1 minute. This is one observation on an older build.
- DNR blocked `edge.ads.twitch.tv` 2/2 on 2026-11-11.
- NOT RUN: 18-minute run with and without extension (stopped, Mac overheating), VOD, off switch in a browser.
- OPEN: one tab on /hasanabi/videos froze in the owner's Chrome; not reproduced in the harness.
- Details: [TESTING.md](TESTING.md).
