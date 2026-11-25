# R6: competitors + MV3 performance + store growth (2026-11-25)
Labels: CHECKED (opened source / read file), REPORTED (search result or source says so, not verified), INFERRED (my reasoning).
LIMITS: Edge/Chrome store pages returned no user counts or ratings to my fetcher (JS-rendered), so most current numbers are UNKNOWN. Reddit was not reached. Search tool summaries were used for most competitor facts, so they are REPORTED.

## Task 1: competitors (public info only)
| Product | Praised | Complaints | Unique | Implementation (as publicly described) |
|---|---|---|---|---|
| Total Adblock (Total Security Ltd, a bundle vendor) | Blocks well at first; Trustpilot ~4.4 from ~31k reviews (REPORTED, ca.trustpilot.com/review/totaladblock.com); Edge listing ~1.4K ratings (REPORTED, microsoftedge listing kkkldohdhcfhpjchcefpkfhjfeapdmek) | Auto-renewal and refund complaints; ratings said to look inflated (REPORTED, getblockify.com, standsapp.org blogs, both competitor-ish) | Freemium upsell, antivirus bundle | Extension; engine undocumented (UNKNOWN) |
| Surfshark CleanWeb 2.0 | Scores >90 on adblock-tester in Chrome, blocks YT ads (REPORTED, pcrisk.com) | Popups still appear; "slow/buggy" Firefox review; no one-click disable | Cookie-popup blocker, data-breach alert, malware/site-safety alert (REPORTED, support.surfshark.com/hc/en-us/articles/8801097429138) | Extension runs without VPN; app version filters at network level (REPORTED). Breach/malware = server-side lookups (INFERRED) |
| NordVPN Threat Protection (extension) / Pro | TPP 86/100 adblock-tester (REPORTED, allaboutcookies.org) | Extension only blocks malicious sites and trackers; real ad blocking sits in the desktop app; no YT ad blocking | Malicious-URL/malware blocking, file scan | Ad blocker is in the app, not browser-bound, so MV3 does not affect it (REPORTED, nordvpn.com/blog/manifest-v3-ad-blockers). Extension = URL reputation (INFERRED) |
| Stands Fair AdBlocker / Stands AdBlocker | Free; high store ratings | One review site scores 58/100, weak on adblock-tester (REPORTED, adblock-tester.com/ad-blockers/stands-ad-blocker); another gave 100/100; bot-review claims and ownership concerns (unverified) | "Fair" ads concept; MV3 beta listing exists | Not documented (UNKNOWN) |
| AdBlock (getadblock.com) | Very large base; vendor claims "60M+ users" (vendor claim) | Not found in my searches | Acceptable Ads on by default (long-known; not re-verified here) | EasyList-style filter lists (REPORTED by general knowledge); MV3 status UNKNOWN |
| Opera built-in | Fast, no extension; shield toggle | Fewer controls | Engine-level blocking; EasyList + NoCoin + EasyPrivacy + anti-circumvention lists (forum, anecdotal); only EasyList-format custom lists | Native engine, EasyList-format lists, not modified by Opera (REPORTED, forums.opera.com, blogs.opera.com/desktop/?p=1957) |
| Edge Tracking Prevention | Zero install | Not a full ad blocker | Basic/Balanced/Strict levels, Microsoft-curated tracker list | Browser-native. NOT researched (my search did not run); UNKNOWN beyond common knowledge |
| Malwarebytes Browser Guard | Blocks ads, trackers, scams, malware; payment protection, clipboard-read protection, gTLD blocking (REPORTED, AMO reviews) | Slowdowns on YouTube and image-heavy pages; update regressions; notification noise (REPORTED, AMO ~900 reviews) | Scam/phishing/PUP reputation, "protect payment methods", clipboard protection | Needs "all websites" permission. Reputation lists + request filtering (INFERRED) |
| Poper Blocker | Chrome listing 4.8 from ~81.3K ratings (REPORTED, chromewebstore bkkbcggnhapdmkeljlodobbkopceiche) | Weak on YouTube; Pro needed for full function; some popups slip through | Popup blocking with a "blocked" notice, basic vs advanced popups, notification hiding, cookie requests | Single-purpose. Likely page-world hooks on window.open and click-handlers (INFERRED) |
| Top Edge ad blockers 2026 | A 2026 guide reports Adblock Plus 1.3K ratings / 12M users and a small blocker with 4.2K ratings / 49K users, Oct 2026 (REPORTED, secondhand) | n/a | n/a | Exact current Edge counts: UNKNOWN. Open the Edge listings by hand |

### Features AdBrake lacks (INFERRED from manifest and file list, compared with above)
1. Malware/phishing/scam URL protection and breach alerts (Malwarebytes, Nord, Surfshark). AdBrake has no reputation list.
2. Generic popup/popunder blocking (Poper). Only Twitch scripts exist in the manifest.
3. Scam/clipboard/payment protections (Browser Guard).
4. Per-site "blocked" notifications and counts (Poper, Browser Guard). Badge count exists via DNR.
5. Acceptable-ads style opt-in (optional; mostly a negative for trust).

## Task 2: MV3 performance
### Best practices
- uBOL design: fully declarative, so filtering does not need the service worker (REPORTED, github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ)). Rules in static rulesets, scripts via scripting.registerContentScripts. Per-site cosmetic/scriptlet filtering uses optional host permissions the user grants (REPORTED, CWS listing).
- Chrome says MV2 blocking webRequest could degrade page and extension performance, hence DNR (REPORTED, developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests).
- Cold start: keep top-level SW code minimal, register listeners synchronously, avoid parsing big JSON at wake (INFERRED, standard MV3 practice).
- Large rule data: static rulesets (browser-indexed, free of SW memory); dynamic rules only for user lists; shard big cosmetic JSON by host hash and fetch one shard (INFERRED).
- insertCSS (origin USER) is not blocked by page CSP and adds no DOM node; a style tag can be hit by CSP style-src and shows in the DOM (INFERRED/common knowledge).
- Procedural cosmetic filters (:has-text, :xpath, :upward) need JS plus MutationObserver; keep them to matched hosts only, throttle, avoid subtree observers on document.
### Benchmarks 2025-2026
- None found that compare uBOL vs AdGuard MV3 vs Ghostery vs ABP. The searches only returned old or vendor numbers. Say so; run our own.
- Ghostery/WhoTracks.me 2019 study: network engines only, Ghostery engine ~1.8 MB, uBO ~1.6x, ABP 8.4x; median decision 0.007 ms (CHECKED, ghostery.com/blog/adblockers-performance-study; Ghostery-authored, old, MV2-era).
- uBO wiki memory benchmarks exist but predate MV3 (REPORTED, github.com/uBlockOrigin/uBlock-issues/wiki).
### Measuring page-load impact (INFERRED method)
Lighthouse/CrUX-style runs with extension loaded vs not, 50-100 top pages, 5 runs each, median; record LCP, TBT, CLS, total transfer, blocked requests. Memory: chrome://system or Task Manager (Extension: service worker + per-tab content-script cost). Use a fixed HAR or local mirror to cut noise. Check SW wake count per navigation via chrome://serviceworker-internals.
### AdBrake risks (CHECKED reading of files; the impact is INFERRED)
1. src/shared/blocking.js:287,297-298: ads_generic.css (224 KB) and cookies_generic.css (314 KB) registered on all http(s), allFrames, document_start. Every frame and iframe parses a ~540 KB selector list; style-recalc cost grows with the DOM. Fix: exclude tiny/sandbox frames if possible, split by top-100 selectors plus per-site CSS, or scope allFrames to false for cookies CSS.
2. src/content/general.js:52 + src/background/general.js:~290-310: every top-frame navigation sends a message, which wakes the service worker. Then the worker loads rules/cosmetic/site.json (1.3 MB) and generic.json (556 KB) via fetch+json() (background/general.js:~57-66, loadJson). The in-memory cache is lost on each SW restart. This is the main cold-start and CPU cost. Fix: pre-shard JSON by host/eTLD+1 (small files), or register per-site CSS via registerContentScripts with exact matches, or keep the host index in storage.session.
3. src/background/general.js:~232-250 (syncScripts): getRegisteredContentScripts + storage.get on every apply (each SW start via onStartup). Signature short-circuit is good; the calls still run at each wake. Minor.
4. src/content/cosmetic.js:190: MutationObserver on documentElement with subtree+attributes; callback loops over added nodes with getElementsByTagName('video') (line 150) per node. Twitch-only (manifest content_scripts matches twitch.tv), so bounded; still costly on chat-heavy pages.
5. src/content/cosmetic.js:76: CSS uses `:not(...):not(:has(...))`. :has() is expensive on large DOMs. Line 116 scanBoxes does a full-document querySelectorAll per scan, run on every throttled mutation burst.
6. src/content/cosmetic.js:184-186: style tag instead of insertCSS; can be blocked by a strict page CSP and is visible to page scripts (INFERRED). Twitch has CSP; check it still works.
7. manifest.json: host_permissions <all_urls> (store warning "read and change all data"); `declarativeNetRequestFeedback` only needed for getMatchedRules/debug (verify use before removal; badge count uses displayActionCountAsBadgeText which does not need it); `unlimitedStorage` should be justified. Fewer warnings help conversion (Task 3).
8. Static rules: privacy_1.json 2.2 MB and ads_1.json 1.4 MB enabled by default; trackers disabled. Fine for DNR; verify the global static budget on low-end devices (UNKNOWN; not measured).
9. Not read: src/background/service-worker.js hot paths (storage.session writes per request at lines ~135-190 could be chatty: INFERRED, not profiled).

## Task 3: store growth (10 lines; mostly INFERRED/common practice, not verified from a primary source)
1. Ranking signals: install velocity, rating and review count, keyword in title/short description, recency of updates (INFERRED).
2. Title: a keyword plus brand ("AdBrake – Ad Blocker"); that is already done.
3. First 132 characters of the description decide the click; state the value (blocks YouTube/video/cookie banners) and "no telemetry".
4. Screenshots: 5 with captions, a promo tile; the repo already has these.
5. Permission warning is the biggest drop-off: <all_urls> shows "read and change all data". uBOL uses optional permissions and lists "permission-less" as a selling point (REPORTED, CWS listing).
6. Ask for a review after a success moment (blocked N ads), never on install; do not buy or bot reviews (store policy; Stands bot claims show the reputation risk).
7. Reply to every 1-2 star review within days with a concrete fix; note it in the changelog.
8. Public support channel plus GitHub issues, and a visible privacy policy; "no remote config" is a trust differentiator.
9. Avoid billing-style surprises: Total Adblock's reviews are dominated by renewal complaints; "free, no upsell" is a positive.
10. Publish a reproducible benchmark vs competitors (the gap found above) as a marketing asset.
