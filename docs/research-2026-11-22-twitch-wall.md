# Twitch adblock wall research, 2026-11-22
Labels: CHECKED = opened today; REPORTED = source says; INFERRED = my judgement. Read-only; no code run; twitch.tv itself not visited.

## 1. Wording and trigger
- CHECKED (Dexerto, Jan 2025): on-stream text "Wait, you're running ad block? Support zackrawrr's earnings by turning off ad block." and "Running ad block? Consider Turbo. Twitch Turbo enables ad-free viewing while still supporting streamers." https://dexerto.com/twitch/twitch-joins-war-on-ad-blockers-by-hitting-users-with-discouraging-messages-3029595
- CHECKED (AdGuard, posted 2025-01-22, updated 2026-07-29): two pop-up types (Turbo, or disable blocker), seen by a Reddit user every 30-60 min, looks like a limited test; AdGuard did not see it itself; no detection method, no workaround. https://adguard.com/en/blog/twitch-ad-blockers-youtube.html
- CHECKED (Twitch dev forum, 2020-21 embeds): "purple ad blocking message", Twitch staff: "designed to address ad blocking and is shown periodically to all embed viewers"; "many ad blockers modify ad behavior"; text only in screenshots. https://discuss.dev.twitch.com/t/getting-a-message-on-my-embeds-that-goes-away-after-a-while/29592
- UNKNOWN: any Nov 2026 wording; no 2026 source quotes it. No source gives the DOM selector, GQL field or player event of the wall. Purple docs, TTV-AB README/constants/CHANGELOG (opened) contain no wall/anti-adblock detection description.
- REPORTED (TTV-AB CHANGELOG ~l.1862, 2051): "Ad spoofing ... sends fake ad-watch beacons to reduce anti-adblock fingerprinting". So the likely signal is: the page requests an ad (edge.ads.twitch.tv/ads, bp=preroll/midroll), then expects playback/completion beacons; blocked requests or missing completion = "ad-block behaviour" (INFERRED).
- Purple observed: page asks edge.ads.twitch.tv/ads (bp=midroll) after a twitch-maf-ad DATERANGE and plays VAST video or HTML creative; also /directory/all calls /ads/format and /ads. https://github.com/arthurbolsoni/Purple-adblock/blob/main/docs/server/ads.md
- Purple finding: ad UI (video-ad-label, video-ad-countdown) shows when stitched-ad/quartile DATERANGE lines reach the player (3/3) and not when stripped. https://github.com/arthurbolsoni/Purple-adblock/blob/main/docs/findings/2026-10-08-ad-ui-on-early-breaks.md

## 2. Other projects (CHECKED in raw source, GosuDRM/TTV-AB main)
- src/modules/hooks.ts l.1-40 selectors removed/reset after ad: [data-test-selector="display-ad"], [data-test-selector="ad-banner"], [data-a-target="ads-banner"], iframe[data-test-selector^="sda-iframe-"], iframe[title="Stream Display Ad"], iframe[class*="stream-display-ad__iframe_lower-third"], .stream-display-ad, [class*="video-player--stream-display-ad"], pip/mini-player containers.
- hooks.ts ~7960: _isClientSideAdRequestUrl matches origin edge.ads.twitch.tv or vaes.amazon-adsystem.com with path /2018-01-01/3p/ads, /ads, /ads/format. It is BLOCKED only for VOD pages ("Blocked client-side VOD ad request", CHANGELOG l.1114: "leaving live streams ... untouched"). On live it only logs.
- api.ts _notifyAdComplete (~l.646-945): reads RADS token from stitched-ad DATERANGE and sends completion beacons (Ad Spoofing, default on).
- CHANGELOG l.1411,1413: mutes Twitch's separate client-side ad <video> as soon as it appears; purple "commercial break" slate stuck for up to 90 s was a bug.
- vaft forks, Purple code, uBO/AdGuard filter lines: NOT read (UNKNOWN). uAssets last Twitch commit 2025-07-26; AdguardFilters 2026-07-19 (titles only, see research-2026-11-21).

## 3. Our DNR rules (CHECKED, python over rules/*.json)
- rules/client_ads.json id1: block ||edge.ads.twitch.tv^ (initiator twitch.tv; xhr, media, script, image, ping, other) - all pages incl. live.
- client_ads.json id2: block ||amazon-adsystem.com/aax2/apstag.js (script, initiator twitch.tv).
- rules/trackers.json id1/2: block twitch.tv/r/s/ scripts and /r/c/ images (initiator twitch.tv). Purpose unknown; INFERRED to be Twitch's own telemetry/ad-adjacent.
- ads_1.json 70: block ooproxy.azurewebsites.net with initiator imasdk.googleapis.com (irrelevant). privacy_1.json 3306: .doubleclick.net/ images globally (Twitch uses IMA/doubleclick? UNKNOWN). No rule on spade/countess/imasdk script itself. src/ has no reference to edge.ads or apstag.

## 4. Ranked gaps (INFERRED)
1. DNR blocks edge.ads.twitch.tv on live pages (and apstag.js): the page sees an ad request fail, the plausible adblock-wall trigger and the CSAI path; TTV-AB leaves live requests alone. Fix: remove client_ads id1/id2 (at least for non-VOD) and instead hide/mute the beside-player ad (selectors above, mute second <video>).
2. No ad-completion/quartile beacon spoofing for stitched breaks (TTV-AB _notifyAdComplete). Optional.
3. Cosmetic: ensure the selectors above are hidden; check rules/cosmetic for twitch (grep found none in site.json twitch entries).
4. Trackers id1/id2 (twitch.tv/r/s, /r/c): verify what they are before keeping.
5. Gaps from research-2026-11-21 remain (backup types, persisted hash fallback, etc.).
