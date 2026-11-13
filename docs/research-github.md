# Twitch video ad blockers: open-source survey (as of 2026-11-11)

Labels: CHECKED = I opened the source (repo file, API response, issue page). REPORTED = a page/person says so, not verified by me. ASSUMPTION/UNKNOWN = stated as such.
Method: GitHub REST API (unauthenticated, hit rate limit part-way), raw files, WebFetch, shallow clones in scratchpad/repos (nothing executed). Reddit was NOT directly accessible; web search returned only SEO blogs and old threads (2023-2025). No Reddit evidence is claimed.

## Comparison table

| Project | Form | Technique | Stars (approx) | Last commit | Still works? (evidence) | Main weaknesses |
|---|---|---|---|---|---|---|
| arthurbolsoni/Purple-adblock | Chrome MV3, Firefox MV2, userscript | Hooked `window.Worker`; rewrite media m3u8; backup access tokens by playerType; swap ad segs for live segs of backups; empty seg answers; DNR + fetch stub for `edge.ads.twitch.tv` (CSAI) | 509 | 2026-11-09 (v2.7.3) | Probably yes: daily commits, 3 open issues, pinned "ads getting through" #111 | Audio desync on Firefox fMP4 channels (#112, fix in 2.7.3 awaiting confirm); preroll needs one player restart; no VOD; single maintainer |
| GosuDRM/TTV-AB | Chrome MV3 + Firefox (MV3), store-listed | Same family: worker hook, backup stream search, verified clean backup, return to native after N clean checks; CSAI request blocking on VODs | 131 | 2026-11-06 (v26.0.3) | Probably yes: 0 open issues, many fixes Oct-Nov | Rewinds/stream breakdowns reported Oct (#81, #86, #88, #91, #96); 360p low-quality fallback default; deliberately ignores `twitch-maf-ad` marker (#98) |
| ryanbr/TwitchAdSolutions (vaft fork) | Userscript / uBO scriptlet | pixeltris vaft: worker hook, backup playerType tokens, strip ad segs, player reload; plus CSAI handling, hide separate ad `<video>` | 1,123 | 2026-08-27 (v68.5.7) | Degraded: #266 (2026-10-28) "no longer works as well", "abandoned?"; #129 rollback loop; #249/#247 side ad player | Maintenance gap since Aug; freezes, audio desync (#264), FFZ clash, PIP bugs (#262) |
| pixeltris/TwitchAdSolutions | Userscript / uBO | vaft + video-swap-new (original) | 11,319 | 2026-03-05 (ARCHIVED) | Archived. #506 (2026-03-02/05): black screen "stripping", "broken again" | Maintainer stopped; known buffering/loop issue #492 never fixed |
| younesaassila/ttv-lol-pro | Chrome MV3, Firefox MV2 | Proxy only the usher/master playlist request via third-party HTTP proxies (zGato) so Twitch serves no ad; permissions `proxy`, `declarativeNetRequest`, `webRequest` | 1,890 | 2026-06-19 (code); activity on PRs to 2026-11-06 | Mostly: maintained proxies; but black screen/error 2000 (#426 29 comments, last 2026-10-08), proxy IP 403 (#392), own-proxy still shows ads (#441, 2026-10-27) | Needs third-party proxies (privacy, uptime), buffering at high res far from proxy, no VOD/banner, depends on exit IPs not WAF-blocked |
| ttv-lol/extensions (TTV LOL v1) | Chrome MV2 | Proxy on master m3u8 | 289 | 2023-04-06 | No (REPORTED unmaintained by ryanbr full-list.md) | Dead |
| cleanlock/VideoAdBlockForTwitch (fork of muleyo's) | Chrome MV3 | Switch to ad-free stream (480p) during ads; proxy/embed fallback | ~1.6k (page; may be parent's count) | UNKNOWN (API redirected to muleyo repo, pushed 2023-02-17) | UNKNOWN; listed "unmaintained" in ryanbr full-list.md | Original extension was removed from stores for referral-link injection (REPORTED, ghacks/tecnoblog titles in search, not opened) |
| uBO twitch-videoad / uAssets | uBO scriptlet (external) | Not in uBO master: grep of resources.txt, scriptlets.js found no `twitch`. Users load vaft file via `userResourcesLocation`. uAssets only has cosmetic filters | n/a | uAssets quick-fixes 2026-07-19 (commit 11edaf1, issue #5184) | Cosmetic only: hides new side/chat Amazon `<video>` ads | Cannot stop SSAI; scriptlet may "randomly stop being applied" (#200 per README) |
| AdGuard (Extra / apps) | Extension + userscript | Closed/own scripts (`AdGuard Extra` v1.1.35, 2026-05-15 per store page via search) | n/a | n/a | UNKNOWN, vendor claims only; ryanbr README lists it as an alternative | Cannot inspect technique; no evidence either way |
| Brave built-in twitch scriptlet | Browser | Same hook approach (Purple cites it as reference implementation) | n/a | n/a | REPORTED working (#506 comment, 2026-03-05, "experimental ad blocking") | Brave only |
| iri-dev/WardenOne | Chrome MV3 unpacked bundle | General privacy suite with "Twitch tools"; no detail visible | 21 | 2026-11-11 | UNKNOWN | Not a focused blocker; not in store |
| AlexRabbit/ADios | Host/DNS lists | DNS blocking | 201 | 2026-11-11 | Not applicable to SSAI (ASSUMPTION) | DNS cannot split ads from the video CDN |

Other repos seen in search, not evaluated: Kite1219/TwitchPlus-AdBlock-Rewind, Helli24/TwitchAdSolutions (fork), xBandaku branch (mentioned in ryanbr #266), ryykitty/twitch-patched.

## How current Twitch ads are delivered (evidence)

1. SSAI: ad segments stitched into live media playlist, EXTINF title `Amazon|<id>`, DATERANGE classes `twitch-stitched-ad` etc. CHECKED: Purple docs/server/behaviors.md B-007..B-009 (observed 2026-10-03).
2. Backup player types also return ads: `frontpage` had ads on 112/121 polls in prerolls (2026-10-07). CHECKED, B-012. Backup tokens requested during a preroll get their own preroll (B-052).
3. CSAI: `twitch-maf-ad` DATERANGE over live segments; ad fetched from `edge.ads.twitch.tv` (B-011; marked "Reported (May 2026)"). TTV-AB #98 (2026-10-26) saw 19 such events in one logged-out session.
4. New since ~2026-07-13: standalone `<video>` ad elements beside the player and above/in chat, sourced from m.media-amazon.com/cloudfront mp4, delivered outside the m3u8 (ryanbr CHANGELOG v68.5.6; issues #247, #249; uAssets commit 11edaf1). Also stream shrinks every ~3 min for ~40s (#249 comment 2026-10-19).
5. Server-side token binding: `parent_domains` and `site` token yields "fake ads"; Purple asks as `popout` and drops `parent_domains` (REPORTED from Brave comment, B-013, F-12).

## Which approaches still work with current Twitch (Nov 2026) and evidence

- Worker-hook + backup tokens + segment surgery (Purple, TTV-AB, vaft): CHECKED active development through 2026-11-09, with 2026-10 fixes for new behaviors (CSAI, fMP4/HEVC/AV1, PIP). Evidence of working is the maintainers' own commits/tests plus few open complaints; I have no independent test. The upstream vaft is not keeping pace: pixeltris archived 2026-03-05, ryanbr's own users ask if it's abandoned (2026-10-28 to 11-09, one saying "player errors out" on 11-09).
- Proxy of usher (TTV LOL PRO): works when proxies and exit IPs are healthy; maintainers say proxies are fine (zGato 2026-07-19), users report black screens/error 2000 as recently as 2026-10-08, and ads with own proxy (2026-10-27). ryanbr README still calls proxies "the most reliable". Does not address the new side-video ads (ASSUMPTION; ttv-lol-pro README says use uBO for banners).
- uBO cosmetic filters: needed for new side/chat video ads (uAssets 2026-07-19). The class names changed repeatedly (Harest 2026-07-18 said old hooks were removed by Twitch).
- uBO scriptlet loading vaft: ryanbr #129 (2026-04-16 to 2026-07-01, 57 comments) "no longer useable" on Firefox, rollbacks; fixed partly in v68.5.0 (2026-07-23). Userscript preferred.
- Pure DNR/URL blocking: ASSUMPTION it cannot stop SSAI (same host/CDN as live video); only CSAI (`edge.ads.twitch.tv`) is blockable; Purple does exactly that on Chromium.
- MV3 specifics CHECKED: Purple and TTV-AB use `content_scripts` with `world: "MAIN"`, `run_at: document_start` to replace `Worker` before the player; no webRequest blocking needed. TTV LOL PRO uses `proxy` + `webRequestAuthProvider`.

## Top failure modes (with evidence)

1. Freeze/buffering/looping segments/audio desync after switching playlists (pixeltris issues.md; #492; ryanbr #264 2026-10-19; Purple #112 2026-10-19..11-10; TTV-AB #81/#88/#91 Oct 2026).
2. Black screen / "stripping" when no clean backup exists (pixeltris #506; ryanbr #129; TTV-AB #92). Cause: every backup type also has ads (B-012).
3. Non-playlist ads: side/chat `<video>` ads and CSAI (ryanbr #247/#249; TTV-AB #93, #98; uAssets 11edaf1).
4. Post-ad player reload problems: long load, FFZ video-element recreation clash, hidden-tab wedge, 360p stuck (ryanbr #129 and v68.5.0; TTV-AB #75; Purple preroll restart ~1s).
5. Twitch changes that silently break hooks: player structure moved to `player.playerInstance.core` (pixeltris #499, 2026-02-10), GQL hash/token behaviour (embed "server error"), A/B tests; plus proxy-side 403s (ttv-lol-pro #392) and error 2000 / network errors (pixeltris #355, Purple #108).

Also: userscript manager quirks (Greasemonkey unsupported; Chrome needs "Allow user scripts"; pixeltris #497), running two blockers together (all READMEs), tab-visibility throttling by Twitch (ryanbr #249).

## Not done / unknown

- Reddit threads not read; GitHub API rate-limited after ~35 calls, so Purple #112 and TTV-AB issues beyond titles were skimmed. cleanlock's last commit and AdGuard Extra's technique unknown. I did not test any extension against live Twitch.
- Clones: /private/tmp/claude-501/-Users-Marsel--claude-spares-spare-AW3GaV/345aee0c-f0eb-4daf-8201-7772c9f743df/scratchpad/repos/ (Purple, TTV-AB, ryanbr, ttv-lol-pro). Purple docs/server/*.md and docs/findings/ are the richest primary source on current Twitch behavior.
