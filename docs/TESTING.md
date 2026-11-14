# Testing

Status as of 2026-11-12. Only what was run, with evidence, is marked PASSED. Statuses: PASSED,
FAILED, NOT REPRODUCED (the situation did not happen, so nothing is proven), NOT RUN.

## Test matrix (2026-11-12)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit tests (`bash tests/run.sh`), incl. bundle-load and off-switch tests | PASSED | "ALL TESTS PASSED (134 tests in 9 files)"; validate_manifest OK (143 checks); `tools/build.py --check`: "bundles up to date". Off-switch cases are in page.test.js, content.test.js, bundle.test.js and the worker/recovery disabled-path tests. |
| 2 | Browser smoke test (`--smoke`) | PASSED | SMOKE PASS 17/17, `results/20261112-231013-smoke` |
| 3 | Live playback in harness (fresh logged-out profile, hasanabi 2 min, 480p, refresh, SPA switch to zackrawrr) | PASSED | Consent "Reject" clicked. Video advanced: watch 118 s, 480p 38 s (height 480), refresh 38 s, channel switch 58 s. Chat +1398 lines. 0 extension errors (34 Twitch errors). Report: `results/20261112-230309-live-hasanabi/report.md`. |
| 4 | Worker hook and token rewrite in live run | PASSED | Worker capture: 4 usher + 164 m3u8 requests; page token playerType rewritten (`popout` seen). |
| 5 | Ad blocking in harness (backup / strip) | NOT REPRODUCED | 160 media playlists scanned, 0 had ad markers: Twitch served no ad in that run. |
| 6 | Ad blocked in owner's real Chrome | PASSED (one observation, older build) | On twitch.tv/jynxzi the extension toast "Ad blocked – using backup stream" appeared; video advanced 8.0 s in 8 s, no pause or stall in ~1 min; no Twitch ad label visible. Build was before the off-switch changes. |
| 7 | Client-side ad request block (DNR) | PASSED | Earlier run 2026-11-11: `edge.ads.twitch.tv` blocked 2/2 (`results/20261111-215639-live-hasanabi`). Effect on the player not verified. |
| 8 | Bundle fix in real Chrome (MAIN-world `window.Worker` is the hooked class, install guard set) | PASSED | Checked in the owner's Chrome. |
| 9 | Chat, channel points in real Chrome (logged in, 7TV) | PASSED | 297 chat lines rendered; points widget present (presence only). |
| 10 | Channel points in harness | NOT RUN | Not applicable: logged-out profile. |
| 11 | Performance in harness | MEASURED, NO BASELINE | CPU avg 35.9 %, max 113 %; JS heap 92 to 98 MB (max 338 MB). Window was 1920x746. No comparison run. |
| 12 | Long (18 min) logged-in run with and without extension | NOT RUN | Started, then stopped on owner request (Mac overheating). |
| 13 | VOD playback | NOT RUN | |
| 14 | Popup status ("Reload needed" gone) and extension error list in real Chrome | NOT RUN | chrome:// and extension pages cannot be reached by the tool. |
| 15 | Off switch in a real browser | NOT RUN | Unit-tested only (row 1). |
| 16 | Install on another PC from the zip | NOT RUN | Zip built: `dist/twitch-ad-shield-1.0.0.zip`, 32 files. |
| 17 | Mid-roll, recovery (stall, reload, Degraded) live | NOT RUN | Unit-tested only. |
| 18 | Clips, embedded player, Turbo | NOT RUN | |
| 19 | **OPEN ISSUE:** tab twitch.tv/hasanabi/videos froze in owner's Chrome (renderer unresponsive > 2 min) | OPEN, NOT REPRODUCED in harness | Same page, current build, harness Chrome: stayed responsive (evals at most 0.6 s over 40 s). Cause unknown: old build, 7TV interaction, or unrelated. |

## How to run


| Command | Network | What it covers |
|---|---|---|
| `tests/run.sh` | none | All `tests/*.test.js` in JavaScriptCore (`jsc`) with synthetic fixtures, then `tests/validate_manifest.py`. |
| `python3 -I tests/validate_manifest.py` | none | manifest.json, rulesets, referenced files, permissions, MAIN_FILES consistency. |
| `python3 -I tools/live_test.py --smoke` | none to Twitch (headless Chrome, throwaway profile, background networking disabled) | Extension loads via CDP `Extensions.loadUnpacked`; service worker; script registration and on/off; popup; options; page/worker hooks on `about:blank`; console errors. |
| `python3 -I tools/live_test.py --live CHANNEL --minutes 10 --vod URL --switch-to CH2 --compare-without-extension` | **Twitch** | Everything in the matrix below marked "live". Needs approval before running. |

Fixtures in `tests/fixtures/` are **synthetic**, modelled on `docs/research-technique.md` and
`docs/research-github.md`; they are not captures of real Twitch traffic.

## Notes for the live run


- The harness clicks "Reject" on Twitch's cookie consent banner (never "Accept") and
  "Start watching" on the mature-content gate, and starts the video muted if autoplay is blocked.
- Reports redact query strings of recorded URLs (usher and GQL URLs carry tokens). Request
  headers are not recorded.
- Results go to `results/<timestamp>-live-<channel>/` (`report.json`, `report.md`, screenshots).

## Offline results (run 2026-11-11, older counts; current counts are in the matrix)
 (run 2026-11-11)

| Suite | Tests | Result |
|---|---|---|
| `tests/m3u8.test.js` – detection, midroll, DATERANGE classes, stripping (preroll, midroll, all-ads, CUE, VOD, CRLF), sequence/discontinuity, parseMaster, codecs, pickVariant exact/closest/audio, HEVC filter, usher URL rebuild | 32 | PASS |
| `tests/processor.test.js` – fake fetch: site ads → popout clean chosen + pinned; pinned first + cached master; break end; all backups ads → strip; lockouts; ad segment cache TTL; last-clean fallback; token error; autoplay never pinned; degraded; CSAI-only; internal exception → passthrough; fetch rejection; unknown playlist; VOD; custom order | 21 | PASS |
| `tests/worker.test.js` – generated worker source compiles (`new Function`), `"use strict"` hoisting, JSON escaping; runs against a fake worker global: passthrough, master rewrite, token round-trip through page messages, strip + blank TS answer, exception passthrough, message isolation, disabled-at-runtime passivity | 13 | PASS |
| `tests/recovery.test.js` – no timer until armed, paused ≠ stall, soft kick then one reload, reload cap → degrade, per-channel window, missing player state, exception disarms, React fiber walk | 10 | PASS |
| `tests/settings.test.js` – defaults, frozen config, playerType validation, normalize, GQL body/headers/capture/rewrite/parse, frame rules, stats, popup status | 17 | PASS |
| `tests/syntax.test.js` – every JS file compiles, factories self-contained, page.js inert without namespace, no U+2028/2029 | 20 | PASS |
| `tests/validate_manifest.py` | 136 checks | PASS |
| `tools/live_test.py --smoke` (Chrome 157.0.8103.51, headless=new) | 14 checks | PASS |

## Live run 2026-11-11 (hasanabi, 8 min, with and without extension) — INCONCLUSIVE

Report: `results/20261111-215639-live-hasanabi/report.md`.

- Video never played in EITHER run (baseline too), so no ad-blocking result can be drawn.
  Cause (from screenshots): headless window is ~756 px wide and Twitch's "Cookies and Advertising
  Choices" banner covers the page; the player never starts.
- Harness also recorded 0 usher/m3u8 requests in both runs: worker requests are not captured
  (needs CDP `Target.setAutoAttach` for worker targets).
- What it did show: DNR `client_ads` blocked 2/2 `edge.ads.twitch.tv` requests (baseline: 1, not blocked);
  no page crash; Chrome CPU avg 20.8 % (ext) vs 22.4 % (baseline); JS heap peak 205 MB vs 213 MB.
- Harness fixes listed after this run (1920x1080 window, consent "Reject", worker auto-attach,
  main-player video state) were made on 2026-11-12.

## Live probe 2026-11-11 (python, playlists only)

- All five player types (site, popout, embed, mobile_web, autoplay) on hasanabi returned playlists
  with no ad segments at probe time; autoplay is capped at 360p.
- Every playlist carried a `twitch-trigger` DATERANGE. It was in the ad-marker list — a false positive
  that would have flagged every stream as an ad. FIXED in src/config.js; regression test added (114 tests pass).

## superadblocktest.com (2026-11-14)

Run with `python3 -I tools/site_test.py` (headless Chrome, fresh profile, clicks "Start test",
reads every probe row). Full results: `results/<timestamp>-superadblocktest/` (gitignored).
The test is 482 `fetch(no-cors)` probes of `https://<host>/`, `/favicon.ico` and `/robots.txt`
from superadblocktest.com; a host counts as blocked when all three fail. The page itself
renders no cosmetic or script-path checks in the scored run.

| Run | Protection score | Raw | Blocked |
|---|---|---|---|
| No extension | 11-13% | 13-14% | 62-66/482 (DNS failures, dead hosts) |
| Ad Shield before (`main`, 425293e) | 71% | 71% | 341/482 |
| Ad Shield after (curated host rulesets) | **92%** | **95%** | 458/482 |

Module scores after: Ad networks 159/160, Trackers 151/162, Video ads 13/17, Affiliate 23/23,
OEM telemetry 69/69, Consent / A/B 14/22, Risky hosts 14/14.

Why the 141 misses before: 127 hosts are in EasyList/EasyPrivacy, but only on certain paths or
resource types (e.g. `||kochava.com/track/`, `||quantserve.com^$script`), and the test
fetches `/`. The other 14 are not in any of the lists. None was caused by a filter our converter
skips (`$popup`, scriptlets and so on). Fix: `rules/curated_hosts.txt` (our own data) blocks
whole hosts, third-party only, never main_frame (`ads_curated` / `privacy_curated`).

Remaining 24 reachable, all deliberate:

| Host(s) | Reason |
|---|---|
| redirector.googlevideo.com, dai.google.com, ssl.p.jwpcdn.com | video delivery / player; blocking breaks playback |
| bea4.v.fwmrm.net, 2975c.v.fwmrm.net | blocked by our rule, but EasyList's own exception `@@\|\|v.fwmrm.net/?$xmlhttprequest` (priority 2) wins for this path, on purpose |
| connect.facebook.net, graph.facebook.com, graph.instagram.com, i.instagram.com | Facebook login, embedded posts and feeds |
| widgets.pinterest.com | share / save buttons |
| cdn.cookielaw.org, consent.trustarc.com, cdn.privacy-mgmt.com | consent platforms; some sites wait for them. Banners are hidden / auto-rejected instead |
| cdn./api.optimizely.com, cdn./st.dynamicyield.com, clientstream.launchdarkly.com | anti-flicker snippets hide the page; feature flags gate app features |
| widget.intercom.io, js.driftt.com, cdn./api.onesignal.com, static./a.klaviyo.com | support chat, web push, signup forms |

The site test is not run by `tests/run.sh` (it needs the network).

## YouTube (2026-11-14)

Run with `python3 -I tools/youtube_test.py` (headless Chrome, fresh profile, normal user agent,
consent answered "Reject all", 30 s per video, sampled once a second). Full results:
`results/<timestamp>-youtube/` (gitignored).

| Video | Run | Played (content t) | `ad-showing` seen | Ad keys served (HTML / `/player`) | Ad keys the page saw (`ytInitialPlayerResponse` / `getPlayerResponse()`) | Wall | Page exceptions |
|---|---|---|---|---|---|---|---|
| jNQXAC9IVRw | ext | yes (19 s, end) | no | - / adPlacements, playerAds | none / none | no | 0 |
| jNQXAC9IVRw | noext | yes (19 s, end) | no | - / adPlacements, playerAds | none / adPlacements, playerAds | no | 0 |
| kJQP7kiw5Fk | ext | yes (30 s) | no | adPlacements, playerAds / - | none / none | no | 0 |
| kJQP7kiw5Fk | noext | yes (30 s) | no | adPlacements, playerAds / - | adPlacements, playerAds / same | no | 0 |
| 9bZkp7q19f0 | ext | yes (30 s) | no | adPlacements, playerAds / - | none / none | no | 0 |
| 9bZkp7q19f0 | noext | yes (30 s) | no | adPlacements, playerAds / - | adPlacements, playerAds / same | no | 0 |

YouTube sent ad data in both runs; with Ad Shield the page and player never saw it, and playback
was normal. Not proven: the control run showed no actual ad (no `ad-showing`) in this headless
profile, so "an ad that would play is removed" and the skip fallback are not demonstrated live;
neither are feed / Shorts pruning or the anti-adblock wall (none appeared).
