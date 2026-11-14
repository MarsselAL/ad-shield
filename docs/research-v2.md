# Ad Shield v2: research and plan (2026-11-14)

Sections A to C were written by research agents on Sonnet using web search and GitHub. Each claim is tagged CHECKED (the source was opened), REPORTED (taken from a search summary) or UNKNOWN. Section D is the coordinator's decision. Section E records what was built and measured.


## A. What the leading MV3 blockers do

Date of research: 2026-11-14. Tags: CHECKED = I opened the source; REPORTED = a search summary said so, not opened; UNKNOWN = not found.
No GPL code is reproduced here; behaviours are described in my own words.

### A.0 Headline numbers (DNR limits)

| Limit | Value | Since | Tag / source |
|---|---|---|---|
| Static rules guaranteed per extension (GUARANTEED_MINIMUM_STATIC_RULES) | 30,000 | Chrome 89 | CHECKED developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest |
| Global static pool across all extensions | 330,000 | | CHECKED (uBOL FAQ, AdGuard MV3 KB); API doc gives no number, use getAvailableStaticRuleCount() |
| Static rulesets declared (MAX_NUMBER_OF_STATIC_RULESETS) | 100 | Chrome 120 (was 50) | CHECKED |
| Static rulesets enabled at once (MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) | 50 | Chrome 120 (was 10) | CHECKED |
| Dynamic rules total, safe+unsafe (MAX_NUMBER_OF_DYNAMIC_RULES) | 30,000 | Chrome 121 (was 5,000) | CHECKED |
| Unsafe dynamic rules (MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES) | 5,000 (count inside the 30,000) | Chrome 120 | CHECKED |
| Session rules (MAX_NUMBER_OF_SESSION_RULES) | 5,000 | Chrome 120 | CHECKED |
| Unsafe session rules (MAX_NUMBER_OF_UNSAFE_SESSION_RULES) | 5,000 | Chrome 120 | CHECKED |
| Regex rules (MAX_NUMBER_OF_REGEX_RULES) | 1,000, counted separately for dynamic and for static | | CHECKED |
| One compiled regex | must be under 2 KB or the rule is ignored (warning only shown for unpacked extensions) | | CHECKED (you already handle this) |
| "Safe" actions | block, allow, allowAllRequests, upgradeScheme. Everything else (redirect incl. queryTransform, modifyHeaders) is "unsafe" | | CHECKED (doc excludes by omission; the Chrome blog states the four safe actions) |
| isUrlFilterCaseSensitive default | false (changed in Chrome 118, shrinks rulesets) | 118 | CHECKED developer.chrome.com/blog/improvements-to-content-filtering-in-manifest-v3 |
| Disabled extensions' static rules stop counting against the global pool | | Chrome 128 | CHECKED (API doc) |
| getMatchedRules | needs declarativeNetRequestFeedback permission or activeTab; 20 calls per 10 min unless from user gesture | Chrome 91 | CHECKED |
| topDomains / excludedTopDomains conditions | new | Chromium 145 | CHECKED via uBOL FAQ ("partially" enables per-site features) |
| uBOL manifest minimum_chrome_version | 122 | | CHECKED (gorhill/uBlock platform/mv3/chromium/manifest.json) |

Ordering at equal priority: allow/allowAllRequests, then block, then upgradeScheme/redirect; order within the same action is NOT guaranteed, so set priority explicitly (CHECKED, API doc).
main_frame is NOT matched by default when resourceTypes is omitted (CHECKED, API doc). allowAllRequests must list resourceTypes (main_frame, sub_frame only).

### A.1 Scriptlets

**What they are.** Small named JS functions that run in the page's own JS world (MAIN) at document_start, and patch page APIs before site code runs. Filter lines look like `example.com##+js(name, arg1, arg2)`. "Trusted-" variants are only allowed from vetted lists because they can do arbitrary things.

**How uBOL injects them (CHECKED, gorhill/uBlock platform/mv3/extension/js/scripting-manager.js, lines ~240-300).**
- Uses `scripting.registerContentScripts()` with two directives, one for `world: 'ISOLATED'` and one for `world: 'MAIN'`.
- Each directive: `allFrames: true`, `matchOriginAsFallback: true` (so about:blank / srcdoc / blob frames are covered), `runAt: 'document_start'`.
- Script file list is `scriptlet-begin.js` + one pre-generated JS file per enabled ruleset + `scriptlet-end.js`, all under `/rulesets/scripting/scriptlet/{main|isolated}/`. The files are generated at BUILD time (make-rulesets.js); the extension cannot register code from a string, so everything must be in the package (uBOL FAQ, CHECKED).
- `matches` is `*` (all hosts) with `excludeMatches` listing hostnames the user set to "no filtering" or "basic". When the user has only per-site grants, `matches` is the list of granted hostnames instead. So the per-domain selection is mostly done inside the generated script (it checks the page hostname against embedded tables) rather than by hundreds of registrations. (Inference from the code shape; I did not read the generated script.)
- Release 2026.1012: "De-duplicate scriptlet functions across rulesets" (one copy of each scriptlet function, not one per ruleset) (CHECKED, GitHub releases of uBOL-home). Release 2026.926: "web_accessible_resources-based scriptlet filters" added (CHECKED, title only).
- Cost: the scripts are parsed on every page load at document_start across all frames; uBOL de-dupes and keeps them lean. Per-page cost is the browser loading the static JS files; there is no service worker wake-up needed (uBOL FAQ).

**How AdGuard does it in MV3.**
- Chrome Web Store rejected AdGuard's MV3 build repeatedly in early 2025 for remote code: `<script>`-tag injection of rules, remote Quick Fixes download, then scriptlets that accept parameters from rules. Result: scriptlets for built-in filters are hardcoded into the package; custom filters/user rules with scripts are meant to use the `userScripts` API (needs Developer mode) (CHECKED, adguard.com/fc/be/blog/review-issues-in-chrome-web-store.html, dated 3-4 Feb 2025).
- AdGuard ships a library of 81 scriptlets (CHECKED count from github.com/AdguardTeam/Scriptlets wiki/about-scriptlets.md; first 100k chars only, so list may be slightly longer, plus a separate "trusted" list). Library version 2.6.0 dated 2026-11-13 (CHECKED changelog).
- How exactly AdGuard registers them (registerContentScripts vs userScripts per ruleset): UNKNOWN, not opened.

**How uBOL handles user/remote filters (NEW, important).** uBOL declares permission `userScripts` and `offscreen`. Custom filters and subscribed remote lists become (a) dynamic DNR rules for network filters and (b) injected user scripts for cosmetic and scriptlet filters; "Scriptlets are limited to the bundled library in /js/resources/" (CHECKED, github.com/uBlockOrigin/uBOL-home/wiki/Justification-for-the-declared-permissions). FAQ edit (June 2026) says custom filters and external list subscription are now available (CHECKED, FAQ). The offscreen document parses/compiles lists.

**Scriptlet library in uBO (CHECKED file names, gorhill/uBlock src/js/resources/ and scriptlets.js).** Names in scriptlets.js include: abort-on-property-read, abort-on-property-write, abort-current-script, adjust-setInterval, adjust-setTimeout, prevent-refresh, remove-class, remove-attr (attribute.js), webrtc-if, prevent-window-open, close-window, window.name-defuser, overlay-buster, alert-buster, nowebrtc, disable-newtab-links, xml-prune, m3u-prune, call-nothrow, remove-node-text, prevent-canvas, multiup, break-on-call, trusted-replace-node-text, trusted-replace-fetch-response, trusted-replace-xhr-response, trusted-click-element, trusted-replace-outbound-text, trusted-suppress-native-method, trusted-prevent-dom-bypass, trusted-override-element-method. Other resource files: set-constant, json-prune, json-edit, object-prune, prevent-fetch, prevent-xhr, prevent-settimeout, prevent-addeventlistener, prevent-innerHTML, prevent-navigation, prevent-dialog, prevent-clipboard-write, cookie, localstorage, href-sanitizer, noeval, prevent-bab, spoof-css, run-at, replace-argument.
Roughly 60-70 in uBO, 81 + trusted in AdGuard.

**Behaviour of the common ones (my own wording; names are filter-syntax names, which you may implement under any internal naming).**
1. set-constant (`set-constant(path, value)`): at document_start, define the dotted property path (e.g. `adsbygoogle.loaded`) on window with a fixed value (true, false, undefined, null, empty array/object, noop function, 0, "", a number) and make writes by the site ignored. Walks missing intermediate objects with getter/setter traps so it still works when the object is created later. The single most-used scriptlet for neutering ad flags.
2. json-prune (`json-prune(props, needlePropsToRequire)`): wrap JSON.parse (and Response.json in fetch) so that after parsing, listed property paths (with `*` and `[-]` array wildcards) are deleted from the result, optionally only when other named properties are present. Used to strip ad slots from YouTube-like player responses, `playerResponse.adPlacements`.
3. abort-on-property-read / abort-on-property-write: define a getter or setter on a global property path; when site code touches it, throw a ReferenceError-like exception to kill that script. Lets you stop an ad script that reads `window.ads` or writes `window.adblockDetector`.
4. abort-current-inline-script (abort-current-script): same getter trap, but only throws if the currently executing `<script>` element is inline and its text matches a needle (string or regex). Needs `document.currentScript`, so it only catches synchronous inline scripts.
5. prevent-setTimeout / prevent-setInterval (no-setTimeout-if): wrap timers; if the callback source text (and optionally the delay) matches a pattern, do not schedule it (or return a dummy id). Kills anti-adblock countdowns, ad refresh loops. adjust-setTimeout/setInterval instead speeds up (changes delay of) matching timers, used to skip "wait 10 s" gates.
6. prevent-fetch (no-fetch-if) / prevent-xhr: wrap fetch / XMLHttpRequest.open+send; when URL/method/body matches a needle, do not send and answer with an empty (or fixed) response (optionally with `Response` type). Used for ad-network and detector pings, where DNR would be too coarse or where a fake success is needed.
7. remove-attr / remove-class (attribute.js): after DOM load and on mutations, strip named attributes or classes from elements matching a selector. Used to unlock scroll (`overflow` classes) or reveal blurred content.
8. replace-node-text / remove-node-text (+ trusted-replace-node-text): when a `<script>` or text node matching a needle is added, rewrite its text with a regex replacement before it executes, or empty it. The trusted variants replace with arbitrary text. (Trusted ones are only safe in curated lists.)
9. trusted-replace-fetch-response / trusted-replace-xhr-response: regex-rewrite the response body of matching fetch/XHR calls. This is the way to simulate `$replace=` network filters, which MV3 DNR cannot do (uBOL FAQ, CHECKED).
10. trusted-click-element: wait for an element matching a selector and click it (cookie "reject", "skip ad"), with delay/timeout. Overlaps your autoconsent usage.
11. prevent-addEventListener: ignore `addEventListener(type, handler)` when type and handler source match needles (stops blocking of copy/paste/contextmenu, or detectors waiting for `load`).
12. prevent-window-open / close-window / window.name-defuser / disable-newtab-links: pop-up and tab-under defences.
13. nowebrtc / prevent-canvas / spoof-css / noeval / prevent-bab / abort-on-stack-trace / href-sanitizer: smaller utilities (IP-leak via WebRTC, canvas fingerprint, fake computed CSS so bait elements look visible, kill eval, BlockAdBlock stubs, abort only when call stack contains a pattern, un-track outbound links).

**Suggested top 10 for you (by usefulness against real sites, my judgement):** set-constant, json-prune, abort-on-property-read, abort-on-property-write, abort-current-inline-script, prevent-setTimeout (no-setTimeout-if), prevent-fetch, prevent-xhr, remove-attr/remove-class, trusted-replace-fetch-response/xhr-response (or replace-node-text). Add later: trusted-click-element, prevent-addEventListener, adjust-setTimeout.

**Chrome policy line.** Scriptlets bundled in the package are acceptable; scriptlets assembled from remote text were rejected (AdGuard Feb 2025 post, above). Safe design: scriptlet bodies in package, remote data only supplies their arguments... but AdGuard's rejection #5 shows even parameterised scriptlets drew a rejection; treat as risk.

### A.2 $redirect resources (stubs)

- DNR: rule `action: { type: 'redirect', redirect: { extensionPath: '/res/noop.js' } }`; the file must be listed in manifest `web_accessible_resources` (with `matches`/`use_dynamic_url` as needed) or the redirect fails (CHECKED, API doc). uBOL's build copies only the resources a ruleset references (`requiredRedirectResources`) and writes them to web_accessible_resources (CHECKED, make-rulesets.js lines ~587, 1243, 1262).
- Redirect is an UNSAFE action, so: dynamic limit 5,000, and static changes of redirect rules do not qualify for Web Store skip-review (CHECKED, below).
- Resource set in uBO (CHECKED directory listing, gorhill/uBlock src/web_accessible_resources): 1x1.gif, 2x2.png, 3x2.png, 32x32.png, noop.js, noop.css, noop.html, noop.json, noop.txt, empty, noop-0.1s.mp3, noop-0.5s.mp3, noop-1s.mp4, noop-vast2/3/4.xml, noop-vmap1.xml, googletagmanager_gtm.js, google-analytics_analytics.js (+ _ga.js, _cx_api.js, _inpage_linkid.js), googletagservices_gpt.js, googlesyndication_adsbygoogle.js, google-ima.js, google-ima-dai.js, doubleclick_instream_ad_status.js, amazon_ads.js, amazon_apstag.js, adthrive_abd.js, ampproject_v0.js, chartbeat.js, fingerprint2.js, fingerprint3.js, freestar_pubfig.js, hd-main.js, nitropay_ads.js, nobab2.js, nofab.js, noeval.js, noeval-silent.js, outbrain-widget.js, piano-analytics.js, popads.js, popads-dummy.js, prebid-ads.js, scorecardresearch_beacon.js, sensors-analytics.js, click2load.html. (~50 files.) These are GPL, so write your own from behaviour: each stub exposes the same global API as the real script with no-op methods (e.g. gtag/dataLayer.push callbacks that call `eventCallback`, `googletag.cmd`, `pubads()` chain returning self, `google.ima.AdsLoader` that fires ADS_MANAGER_LOADED then completes immediately, `adsbygoogle.push` noop).
- Limits (CHECKED, uBOL FAQ): `redirect=click2load.html` and `redirect-rule=` (redirect only if the request would be blocked) cannot be expressed in DNR. AdGuard MV3 beta also lists `$redirect-rule`, `$header`, `$content` as unsupported (CHECKED, adguard.com/en/blog/adguard-mv3-beta.html).
- Important surprise: a redirect to a stub means a script like noop.js still "loads", which is why it beats plain block for sites that detect failed loads.

### A.3 $removeparam via DNR

- Rule shape (CHECKED API doc: queryTransform is inside `redirect.transform`, so it needs a `redirect` action):
```
{ "id": 1, "priority": 1,
  "action": { "type": "redirect",
    "redirect": { "transform": { "queryTransform": { "removeParams": ["utm_source","utm_medium","fbclid"] } } } },
  "condition": { "resourceTypes": ["main_frame","sub_frame"] } }
```
- `removeParams` is an array of exact key names; `addOrReplaceParams` is a separate list (`replaceOnly` flag since Chrome 94). No wildcard or prefix is documented, so `utm_*` must be listed expanded (utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id, ...). CONFIRMED as "not documented"; I did not test in a browser. uBOL FAQ: regex-based `removeparam=` not supported (CHECKED).
- uBOL build step has a function that expands removeparam rules (`expandRemoveparamsRule`, make-rulesets.js ~line 595); its exact semantic: UNKNOWN (not opened).
- Caveats:
  - It is a redirect, so UNSAFE: counts against 5,000 unsafe dynamic limit; static ruleset updates containing it are not eligible for skip-review.
  - Must list `main_frame` in resourceTypes to affect navigations; omitted resourceTypes excludes main_frame (CHECKED).
  - Loop risk: after the redirect the new URL is evaluated again; since the param is gone no rule matches, so it terminates. Danger only if a rule ADDS/replaces a param (addOrReplaceParams) unconditionally, or if two rules fight. Use `replaceOnly`, or conditions like `urlFilter: "fbclid="`.
  - Keep the matching condition narrow (urlFilter `?fbclid=` / `&fbclid=`) so you don't redirect every navigation. Each redirect is an extra request round trip on main_frame.
  - Chrome doc does not say how many chained redirects are allowed, or case/fragment behaviour (CHECKED absence). Need empirical test.
  - Redirects of same priority have no guaranteed order; set priorities.
  - Some sites break when e.g. `gclid`/`fbclid` needed for login/payment returns; uBO has per-site exceptions; in DNR use an allow rule with higher priority or `excludedRequestDomains`.
- Typical param list (REPORTED/common knowledge, matches AdGuard URL Tracking filter and uBO privacy-removeparam contents; I did not open the lists): utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id, utm_name, fbclid, gclid, gclsrc, dclid, gbraid, wbraid, msclkid, mc_eid, mc_cid, igshid, igsh, yclid, ttclid, twclid, li_fat_id, _hsenc, _hsmi, mkt_tok, vero_id, oly_enc_id, oly_anon_id, ref_src, ref_url, s_cid, ScCid, wickedid, rb_clickid. Verify against upstream lists before shipping.
- Per-domain scoping (e.g. only `igshid` on instagram) is cheap in DNR via `requestDomains`.

### A.4 Specific and procedural cosmetics

- uBOL: specific cosmetic filters are compiled at build time into per-ruleset JS data files and injected by `css-specific.js`; generic ones by `css-generic.js` only in "complete" mode (CHECKED, scripting-manager.js; FAQ says no generic cosmetic by default). Registered as content scripts, `allFrames: true`, runAt `document_idle` for generic (CHECKED lines 127-162).
- Procedural: YES, implemented. At build time cosmetic filters are split into declarative (plain CSS) and procedural (stored as JSON selector objects starting with `{`) (CHECKED, make-rulesets.js ~lines 1083-1100). Runtime file `css-procedural-api.js` (ProceduralFiltererAPI) exists in the content-script folder (CHECKED listing and head of file; it has regex helpers, nonVisualElements skip list). So it runs in an ISOLATED-world content script using DOM queries + MutationObserver (inference), not via the service worker.
- Procedural operators uBO documents (REPORTED from uBO wiki, not opened this session): `:has-text(str|/re/)` match elements by text content; `:upward(n|selector)` walk to ancestor; `:xpath()`, `:matches-css(prop: value)`, `:matches-attr()`, `:matches-media()`, `:matches-path()`, `:min-text-length()`, `:not()`, `:others()`, `:shadow()`, `:remove()` delete the element instead of hiding, `:remove-attr()/:remove-class()` modify.
- Plain CSS now covers `:has()` natively (Chrome 105+), so many former procedural cases (`:has(.ad)`) can be plain CSS; only `:has-text`, `:upward`, `:matches-css`, `:xpath` need JS.
- Cost: a JS filterer per page that re-evaluates on DOM mutations (throttled). uBOL shows it is acceptable but it is the main CPU source of cosmetic filtering. Only inject on hostnames that have procedural rules (you can pre-compute hostname list at build time).
- Rejected filters are logged and dropped at build (make-rulesets.js).

### A.5 Element picker / zapper

- uBOL has both, as popup "tools" (CHECKED, Quick-guide wiki): zapper (temporary removal, also restores scroll) and picker (suggests a filter; slider for specificity; manual cosmetic syntax in expanded view; permanent; editable in dashboard "Custom filters").
- Implementation (CHECKED file listing): content scripts `picker.js`, `zapper.js`, `unpicker.js`, `tool-overlay.js`; UI pages `picker-ui.html`, `zapper-ui.html`, `unpicker-ui.html` are web_accessible_resources with `use_dynamic_url: true`, loaded in an overlay iframe. Keyboard commands `enter-zapper-mode`, `enter-picker-mode`. Overlay launch requires a "valid secret" (release 2026.1110: security hardening, CHECKED title).
- Persistence: user filters stored in storage; cosmetic ones injected as user CSS (`css-user.js`, "Preemptively inject user styles locally", release 2026.920) via content scripts registered through `userScripts` / `scripting.registerContentScripts` per hostname; network ones become dynamic DNR rules (CHECKED Justification page). The exact insertCSS vs registerContentScripts split: UNKNOWN.
- AdGuard has "Block element" in its MV3 extension: not verified (KB page didn't mention it).
- For you: simplest design is picker overlay via `scripting.executeScript` on activeTab, selector saved in storage, then `scripting.registerContentScripts` (one script per hostname, CSS option `css:[...]` is supported by registerContentScripts) or `scripting.insertCSS` on navigation. registerContentScripts persists across sessions; insertCSS does not.

### A.6 List updates after install

- uBOL built-in lists: compiled to static rulesets at build time; change only with extension update; no remote fetch for those (CHECKED FAQ). uBOL ships updated lists roughly every 3-7 days (CHECKED releases list, 2026-08 to 2026-11: 2026.1110.1816, 1103, 1026, 1021, 1018, 1012, 1006, 930...). Web Store review delay per release is noted in each release.
- uBOL user/remote lists (new in 2026): remote list text fetched inside an offscreen document, compiled, network part to dynamic rules, cosmetic/scriptlet part to userScripts; scriptlets limited to bundled library (CHECKED, permissions page).
- Chrome policy (CHECKED, developer.chrome.com/docs/extensions/develop/concepts/content-filtering via search summary; REPORTED): no remote hosted CODE; filter-list data fetched at runtime is "configuration data" and allowed; dynamic rules are the intended runtime route, persist across upgrades. (I did not open this page; the search result summary quotes it.)
- Skip-review (CHECKED, developer.chrome.com/docs/webstore/skip-review): update can publish with no full review (usually live in minutes) if ALL: declarativeNetRequest is a required permission; changes are only to files in `rule_resources`; every added/changed/removed rule is a safe rule; no ruleset added or removed in manifest; nothing else about the item changes; `version` incremented; item not previously taken down/warned. Opt in via dashboard checkbox or Publish API. Extra metadata should be fetched remotely or put in `_metadata` keys in rule files. Redirect/modifyHeaders rules disqualify (REPORTED by DevRel reply per search summary). Even a rule-ID-only change reportedly triggered review in one developer's case (REPORTED, chromium-extensions group).
- AdGuard: built-in filters update only with extension release + review; Auto-update option removed; "Quick Fixes" filter (dynamic rules, shipped in extension) for urgent fixes; custom filters added by URL DO auto-update independently again since v5.4 (issue #2944) (CHECKED KB page for the custom-filter statement; REPORTED for the v5.4 changelog). Earlier plan: "fast-track" every few hours via skip-review plus full updates (CHECKED, Feb 2025 post). Differential updates: planned in beta post, no confirmation they shipped (UNKNOWN).
- AdGuard dynamic overflow order: Allowlist, User rules, Custom filters when above 5,000 (KB; note: the beta post lists user rules first; KB lists allowlist first). AdGuard still quotes 5,000 dynamic although Chrome allows 30,000 safe dynamic; I did not find why (likely because their rules are not all safe, or cross-browser baseline).
- Practical options for Ad Shield: (1) rebuild lists in CI weekly, publish with skip-review (only block/allow/allowAllRequests/upgradeScheme rules in the changed files; keep redirect/removeparam rules in a separate ruleset file that changes rarely); (2) fetch a data-only block list at runtime and install as DYNAMIC safe rules (cap 30,000 block rules; regex ≤1,000); (3) fetch cosmetic selector lists as JSON data (explicitly allowed as configuration), keep scriptlet code in the package.

### A.7 Per-site filtering modes (uBOL)

- Four modes: no filtering, basic, optimal (default, ~17K rules in default set per FAQ), complete (adds generic cosmetic filtering and, per code, broad scriptlet/procedural). Set per hostname via popup slider; "all-urls" is the default entry (CHECKED, Develop wiki and FAQ; Quick-guide only mentions slider).
- Permission model (CHECKED, Justification page and manifest): `host_permissions: ["<all_urls>"]` is granted by default; users can opt into reduced host permissions, then optimal/complete apply only to hostnames where the user granted permission (code branches on `hasBroadHostPermission` and `permissionGrantedHostnames`, scripting-manager.js). `activeTab` is used so the popup can change the current site's mode. Basic mode = network filtering only (DNR rules, no content scripts). Mode implementation = `excludeMatches` lists on the registered content scripts + trusted-site allowAllRequests DNR rules (the "Trusted sites" rules are mentioned in the Develop page). Also permissions: alarms, declarativeNetRequest, offscreen, scripting, storage, unlimitedStorage, userScripts.
- Admin `noFiltering` managed setting exists (release 2026.907).

### A.8 Anti-adblock in MV3

What works (mostly REPORTED / inference; nothing here proven by a single primary source):
1. Scriptlets in MAIN world at document_start: set-constant on detector flags, abort-on-property-read for known detector globals, prevent-setTimeout/prevent-fetch for detection pings, prevent-bab / nobab / nofab stubs (CHECKED names exist in uBO resources).
2. Redirect stubs of known detector libraries (nobab2.js, nofab.js, popads-dummy.js, prebid-ads.js, adthrive_abd.js, freestar_pubfig.js: CHECKED names) so "is the library loaded?" checks pass.
3. Bait-element defence: spoof-css scriptlet (fake computed style) and not hiding generic `.ad`-named classes on sites that probe them (hence uBOL does not apply generic cosmetics by default, CHECKED FAQ).
4. Overlay removal: specific cosmetic hide + remove-class/remove-attr to restore scroll, `:remove()`, and zapper.
5. Rewrite of inline detector code with replace-node-text; response rewriting with trusted-replace-*-response (JS-level simulation of `$replace`).
Does NOT work in MV3: modifying response bodies/headers conditionally on content (DNR "does not allow to programmatically filter according to the content of response headers", CHECKED FAQ), `$replace`, `$header`, `$redirect-rule`, CSP injection beyond modifyHeaders static rules, CNAME uncloaking, dynamic per-request decisions (CHECKED FAQ list).
YouTube-style server-side ad insertion: relies on json-prune plus fetch/XHR response rewriting; breaks often; needs frequent updates (hence the update-channel issue in A.6).

### A.9 Ghostery and Brave

- Brave Shields (CHECKED github.com/brave/adblock-rust README): native Rust engine inside the browser (not an extension), uses uBO-compatible resources for scriptlet injection and redirects, handles network + cosmetic filters, hosts syntax; not bound by DNR limits. Procedural cosmetics and removeparam: README does not mention them (UNKNOWN from this source; Brave publicly supports both, REPORTED/not verified here). Lists update at runtime from Brave servers (REPORTED/not verified).
- Ghostery (Ghostery's MV3 posts, REPORTED via search summary: ghostery.com/blog/manifest-v3-the-ghostery-perspective): uses DNR for blocking, says DNR cannot do cosmetic filtering so a content-blocking engine still runs for cosmetics; its filter syntax reference mentions scriptlets. Ghostery extension repo README (CHECKED) says only that block lists are downloaded at build time; no implementation detail. Current Ghostery MV3 scriptlet/update mechanism: UNKNOWN. Ghostery also does cookie-popup auto-dismissal and tracker database (TrackerDB) based per-tracker controls (README claim).

### A.10 Gaps vs Ad Shield (what you lack, ranked by payoff per effort; my judgement)
1. Scriptlets (set-constant, json-prune, abort-*, prevent-fetch/xhr, remove-attr, setTimeout) via two registerContentScripts directives (MAIN) bundled at build.
2. removeparam as a small hand-curated static ruleset (dozens of rules; unsafe class, so keep it in its own file).
3. Redirect stubs for ~10 key resources (noop.js, 1x1.gif, gtm, ga, gpt, adsbygoogle, ima).
4. Procedural cosmetics (:has-text, :upward, :remove) limited to a pre-computed hostname list.
5. Element picker/zapper (activeTab + overlay + stored selectors + registerContentScripts).
6. Per-site modes (reuse excludeMatches + allowAllRequests).
7. Update channel: skip-review for safe-only static ruleset changes; dynamic safe rules (30,000) for runtime data.

### Sources opened
- https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- https://developer.chrome.com/blog/improvements-to-content-filtering-in-manifest-v3
- https://developer.chrome.com/docs/webstore/skip-review
- https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ)
- https://github.com/uBlockOrigin/uBOL-home/wiki/Justification-for-the-declared-permissions
- https://github.com/uBlockOrigin/uBOL-home/wiki/Dashboard:-Develop and /wiki/Quick-guide
- https://github.com/uBlockOrigin/uBOL-home/releases (via API)
- https://github.com/gorhill/uBlock/tree/master/platform/mv3 (scripting-manager.js, make-rulesets.js, chromium/manifest.json, extension/js/scripting/*)
- https://github.com/gorhill/uBlock/tree/master/src/web_accessible_resources and src/js/resources
- https://adguard.com/kb/adguard-browser-extension/mv3-version/
- https://adguard.com/en/blog/adguard-mv3-beta.html
- https://adguard.com/fc/be/blog/review-issues-in-chrome-web-store.html
- https://github.com/AdguardTeam/Scriptlets (README, wiki/about-scriptlets.md, CHANGELOG.md)
- https://github.com/brave/adblock-rust ; https://github.com/ghostery/ghostery-extension
Not opened (search summaries only): developer.chrome.com/docs/extensions/develop/concepts/content-filtering; ghostery.com/blog/manifest-v3-the-ghostery-perspective; chromium-extensions group threads; AdGuard v5.4 release post.

## B. YouTube ads under MV3 (Nov 2026)

Method: read raw filter lists on 2026-11-14 (uAssets `filters/quick-fixes.txt`, `filters/filters.txt`, `filters/annoyances-others.txt`; AdGuard `BaseFilter/sections/specific.txt`; EasyList `easylist.txt` and `easylist_specific_hide.txt`) and GitHub issue threads via the public API. Rule strings below are facts (URL patterns, object paths). Technique descriptions are in my own words; no scriptlet code is copied. Tags: CHECKED = I opened the source; REPORTED = a source says it, not verified; UNKNOWN.

### 1. What current lists do for video ads (all CHECKED)

uBO quick-fixes.txt, YouTube block (all `www.youtube.com` unless noted):
- Static pre-pruning of the page-embedded player response: `json-prune` of `playerResponse.adPlacements`, `playerResponse.playerAds`, `playerResponse.adSlots`, plus the same three at top level (`adPlacements playerAds adSlots`). Also `set-constant` of `ytInitialPlayerResponse.{playerAds,adPlacements,adSlots}` and `playerResponse.adPlacements` to `undefined` (filters.txt, hosts m., music., tv., www., youtubekids, youtube-nocookie).
- Fetch response pruning (`json-prune-fetch-response`): keys `adPlacements adSlots playerResponse.adPlacements playerResponse.adSlots [].playerResponse.adPlacements [].playerResponse.adSlots`; URL match `/\/player(\?|$)/`; also match `playlist?` and for `/resolve_url?` the path `endpoint.watchEndpoint.unserializedPrefetchData.playerResponse.{playerAds,adPlacements,adSlots}`.
- XHR response pruning (`json-prune-xhr-response`): same keys, URL `/\/player(?:\?.+)?$/`.
- Text-level rewrite of responses (`trusted-replace-xhr-response` / `trusted-rpfr` = replace-fetch-response): replace the literal `"adPlacements"` and `"adSlots"` key names with `"no_ads"` (renaming makes the player ignore them; works even when the body is not parseable JSON). URL regex: `/playlist\?list=|\/player(?:\?.+)?$|watch\?[tv]=/`; fetch: `player?`, `get_watch?`, and any body URL matching `^\W+$`. Also a regex variant that cuts the `"adPlacements"...` array up to the next `"adSlots"` or `"adBreakHeartbeatParams"` key (`/"adPlacements.*?("adSlots"|"adBreakHeartbeatParams")/gms`).
- Network-level `replace=` (uBO only; not possible in MV3 DNR): `||youtube.com/youtubei/v1/player?`, `/youtubei/v1/get_watch?`, `/watch?`, `/playlist?list=` with `"adPlacements"` and `"adSlots"` renamed to `"no_ads"`.
- tv.youtube.com: only the rename approach (the cut-array regex breaks TV).
- Mobile site `m.youtube.com`: `json-edit-fetch-response ..itemSectionRenderer.contents.*[?.adSlotRenderer]` on URL `/get_watch` (removes ad slot items from lists).
- Shorts: `json-prune` / `json-prune-fetch-response` of `entries.[-].command.reelWatchEndpoint.adClientParams.isAd` (delete any array entry whose reelWatchEndpoint.adClientParams.isAd is true), URL `/reel_watch_sequence?` (response root `reelWatchSequenceResponse.entries`). AdGuard also hits `/youtubei/v*/reel/reel_watch` with an equivalent JSONPath, and in Safari filters `entries` after every `JSON.parse` when path starts with `/shorts/`.
- Anti-detection: neuter functions passed to `Promise.prototype.then` whose source text contains `onAbnormalityDetected` (player's abnormality/anti-adblock reporter); AdGuard does the same (both). `setTimeout` speed-up for callbacks with `[native code]` and delay 17000 -> uBO `nano-stb`, AdGuard `adjust-setTimeout` (reduces the "fake buffering" delay).
- Fake-buffering / "player reload" quick fix (uBO + uBOL "Optimal" mode): rewrite the inline `serverContract` script at load, and rotate how the client identifies itself in `/youtubei/v1/player` requests (variants named channel, lactmilli, yahi, inline: suffix on `context.client.userAgent`, `clientScreen:"CHANNEL"`, `params:"8AUB"` / `"YAHI"`, `contentPlaybackContext.isInlinePlaybackNoAd:true`, `lactMilliseconds`, `referer` + `#reloadxhr`). Requests are recognised by the presence of `attestationRequest`. The player is reloaded (`loadVideoById(id, startSeconds)`) until a variant yields a buffer; UNPLAYABLE error with link `support.google.com/youtube/answer/3037019` triggers the next variant. Moves such as patching `JSON.stringify` inbound objects are the lever.
- AdGuard analogue (same idea, other names): constants `pyv`, `param_first`, `param_second`, `client_screen`, `ad_type`, values `eAFgAQ`, `8AUB`, `YAHI`, `CHANNEL`; fakes `document.visibilityState`; reloads player via `loadVideoById` on error screen link `support.google.com/youtube/answer/2802245` (LOGIN_REQUIRED / CONTENT_CHECK_REQUIRED).
- AdGuard extra (Feb 2026+ comments on issue 203236): replace key names `adSlots|playerAds` with `no_ads` in text passed through `.next(` promise callbacks; delete `adSlots`, `playerAds` from objects containing `responseContext` returned through `jspbResponseCtor`; remove `muteOnStart:true` and `youThereRenderer` (the "Are you there" message) from player config; `set-constant ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch=false` (without it the player gets muted); home feed: `json-prune ...richGridRenderer.contents.[-].richItemRenderer.content.adSlotRenderer` on `ytInitialData` and on responses; re-parse `ytInitialData` through JSON once so pruning applies.
- AdGuard base.js patch (network replace, not MV3-portable): text-substitute the `if(!U||!U.adPlacements&&!U.adSlots)` check in `/s/player/*/base.js` to always-true. Variable name `U` is minified and changes; fragile.
- Old/disabled (commented out) in uBO: `ssapConfig` removal (`ytInitialPlayerResponse.playerConfig.ssapConfig`, `ssapPrerollEnabled` in base64 `serverContract`); `www.youtube.com/s/_/ytmainappweb/_/js/` replace of `onAbnormalityDetected`.

### 2. SSAI / SSAP status (2025-2026)

- 9to5Google first reported the test on 2024-06-12; AdGuard post (updated 2026-08-13) says ads "indistinguishable from content", extensions hit hardest. [CHECKED] https://adguard.com/en/blog/youtube-server-side-ad-insertion.html
- Who: logged-in and logged-out vary; uBO team says fake buffering is "account-based" (comment 2026-10-25, issue 30158) [CHECKED]. Not publicly documented which accounts get SSAP; UNKNOWN.
- Blocker approach seen in code [CHECKED, from lists]: (a) read the player's debug string (`getStatsForNerds().debug_info` starts with `SSAP, AD`) while an ad is in the timeline and `seekTo(duration)` of the ad piece to jump over it; (b) AdGuard captures `{start,end,namespace:"ssap",id}` objects pushed through `Array.prototype.push` when experiment flag `html5_enable_ssap_entity_id` is on, and if the video duration equals the last SSAP range's end it sets `video.currentTime` to that range start (skips a trailing ad); (c) detect stuck playback: stats show `buffer_health_seconds` `"0.00 s"` and resolution `"0x0"`, then try next client variant and reload.
- Breakage patterns, all CHECKED in uBO/uBOL threads: 4-24 s "fake buffering" (popup "Experiencing interruptions", bottom-left, `ytd-popup-container ... [position-type="OPEN_POPUP_POSITION_BOTTOMLEFT"]` hidden in annoyances-others.txt:3538); video black but audio plays; first video won't load until refresh; ad appears sporadically (2026-11-13). uBO threads: https://github.com/uBlockOrigin/uAssets/issues/30157 (Firefox, open), #30158 (uBOL, open).
- Unavailable-content error pointing to `support.google.com/youtube/answer/3037019` ("The following content is not available on this app") is the signal for the variant rotation above [CHECKED].
- "Video stuck at 0:00 / white screen": AdGuard section is literally titled "Youtube whitescreen fix" (SSAP preroll flag removal, now commented out) [CHECKED].

### 3. Anti-adblock wall

- Message "Ad blockers are not allowed on YouTube" (May 2023) and "Ad blockers violate YouTube's Terms of Service" (Mar 2025) [CHECKED via AdGuard blog https://adguard.com/en/blog/youtube-new-banner-adblockers-violate-tos.html]; video blocked until allowlisted.
- Element: `ytd-enforcement-message-view-model` (inside a `tp-yt-paper-dialog`/popup container) [REPORTED, userstyle https://userstyles.world/style/12481 hides it]. Data key `enforcementMessageViewModel` in player response / `adBlockMessageViewModel` [REPORTED, ghacks/tildes search snippets; pages not opened].
- Current uBO/AdGuard lists (Nov 2026) contain NO explicit enforcement-key or element rule [CHECKED by grep of those lists]; they defuse it by (1) never giving the player ad data, (2) neutering `onAbnormalityDetected` callbacks, (3) client-variant rotation. Reimplementing: additionally delete those two keys from player response and hide the element + remove `body` scroll lock; UNKNOWN whether keys are still current.

### 4. Cosmetic selectors (EasyList easylist_specific_hide.txt, CHECKED)
```
youtube.com###contents > ytd-rich-item-renderer:has(> ytd-ad-slot-renderer)
youtube.com###contents > ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)
youtube.com##ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)
youtube.com##.ytd-two-column-browse-results-renderer > ytd-rich-grid-renderer > #masthead-ad
youtube.com##ytd-watch-next-secondary-results-renderer > ytd-ad-slot-renderer
youtube.com##ytd-item-section-renderer > ... > ytd-ad-slot-renderer
youtube.com##ytd-search-pyv-renderer
youtube.com###shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)
youtube.com###shopping-timely-shelf, ###sticker-layer, yt-overlay-product-sticker, .ytp-suggested-action-badge, ytd-merch-shelf-renderer > #main
m.youtube.com##lazy-list > ad-slot-renderer, ytm-rich-item-renderer > ad-slot-renderer, ytm-companion-slot[data-content-type] > ytm-companion-ad-renderer
```
AdGuard adds `ytd-rich-item-renderer:has(> #content > ytd-display-ad-renderer)` and `youtube-nocookie.com##.ytp-ad-progress-list`. uBO has `#player-ads` exception, `.video-ads` exception (EasyList). Not seen in these lists (UNKNOWN current use): `.ytp-ad-module`, `ytd-player-legacy-desktop-watch-ads-renderer`, `ytd-promoted-sparkles-web-renderer`; they are old; cheap to include. `:has()` is fine in Chrome CSS.
Hiding alone leaves the empty gap in the feed (user complaint 2026-11-03); AdGuard prunes data instead.

### 5. Network rules (CHECKED unless noted)
- EasyList: `||youtube.com/pagead/`, `||youtube.com/youtubei/v1/player/ad_break`, `||youtube.com/get_video_info?*adunit$~third-party`.
- uBO: `*_ad_$media,domain=youtube.com,3p`; `||googlevideo.com/initplayback?source=youtube&*c=TVHTML5&*oad=$xhr,domain=youtube.com` (TV client ad init); an `expire=` regex over `googlevideo.com/videoplayback` xhr GET 3p (purpose unclear; UNKNOWN).
- Not found in lists: `/api/stats/ads`, `/ptracking`, ctier=L hints (UNKNOWN; do not rely). uBO has a `badfilter` on `api/stats/atr` meaning blocking it caused trouble. `doubleclick.net` blocking is general and safe for youtube.com pages but in-player ad delivery is first-party. Under MV3 DNR you cannot rewrite response bodies, so item 1 must be MAIN-world scriptlets.
- Safe: `/pagead/`, `ad_break`. Risky: blocking `/api/stats/*`, `get_drm_license` (AdGuard excludes it: "Free with ads" movies break).

### 6. Skip fallback (.ad-showing, mute, currentTime=duration, click skip button)
- UNKNOWN whether YouTube detects it (no primary source found). Fact: the uBO quick-fix itself still does a `seekTo(duration)` of the SSAP ad and AdGuard sets `currentTime`, so seeking past ad segments is in current use. Pure DOM skipping also leaves ad-impression pings sent and shows a brief ad flash; with fake buffering penalty it cannot fix stalls. Treat as fallback only.

### 7. uBOL vs uBO (2026)
- uBO on Firefox (v1.76.0): thread #30157 open, 1618 comments, active 2026-11-13; sporadic ads and fake buffering still reported, maintainers answer individually [CHECKED].
- uBOL: "Optimal" YouTube mode is required; threads #28707 (closed 2025-11-17, 164 comments) then #30158 (open, 364 comments); latest version 2026.1110.1816; maintainers: fake buffering is account-based, uBOL reloads player several times (visible lag, high CPU in one report), "no updates related to YouTube recently" (2026-10-25) [CHECKED]. Some 2025 users said uBOL stuttered or showed blank video and moved to Firefox [CHECKED, #28707 comments].
- Chrome Web Store review lag for uBOL fixes [REPORTED, SuperchargeBrowser, low quality]. We register our own scriptlets, so update lag is ours only.

### Recipe table (what to implement first)

| # | Target (hook point) | Neutralise / delete | Why |
|---|---|---|---|
| 1 | `ytInitialPlayerResponse` (setter on window, MAIN, document_start) and `window.ytInitialData` | delete `adPlacements`, `adSlots`, `playerAds`; on `ytInitialData` remove `contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.richGridRenderer.contents[].richItemRenderer.content.adSlotRenderer` items | first page load never hits fetch |
| 2 | `fetch` wrapper for URLs matching `/youtubei/v1/(player|get_watch|reel/reel_watch|browse|search|next)` and `/playlist?` | parse JSON; delete `adPlacements`, `adSlots`, `playerAds`, `playerResponse.{adPlacements,adSlots,playerAds}`, `[].playerResponse.*`; delete `entries[]` items with `command.reelWatchEndpoint.adClientParams.isAd`; drop `adSlotRenderer` from feed items | in-page navigation (SPA) uses fetch |
| 3 | `XMLHttpRequest` (responseText/response getter) for same URLs, incl. `watch?v=...&pbj` style | same as 2 | TV/mobile/legacy still use XHR |
| 4 | Fallback if JSON.parse fails | text replace `"adPlacements"`, `"adSlots"`, `"playerAds"` -> `"no_ads"` | robust to shape changes |
| 5 | `JSON.parse` wrapper (cheap, on `/shorts/` and YouTube responses) | same deletions on objects having `responseContext` | catches inline data paths |
| 6 | `Promise.prototype.then` wrapper | if the callback source contains `onAbnormalityDetected` replace with no-op | stops the ad-block abnormality report |
| 7 | `ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch` | set false | avoids muted playback |
| 8 | player response `playerConfig.audioConfig.muteOnStart`, `messages[].youThereRenderer` | delete | side effects of pruning |
| 9 | CSS | selectors in section 4 + `ytd-enforcement-message-view-model` | gaps/walls |
| 10 | DNR | block `youtube.com/pagead/`, `/youtubei/v1/player/ad_break` (never `/api/stats/*`, `get_drm_license`) | safe network baseline |
| 11 (phase 2) | `#movie_player` watcher | if `getStatsForNerds().debug_info` begins `SSAP, AD`, `seekTo(duration)`; fallback `.ad-showing` -> mute + `currentTime=duration` + click `.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button` | SSAP in-stream ads |
| 12 (phase 3) | client-variant rotation on `/youtubei/v1/player` body (JSON.stringify patch) + player reload | see section 1 "fake buffering" | fixes 4-24 s delay for accounts that get it; complex |

### Risks
- YouTube changes key names and request shapes every few weeks; lists have been patched continuously since 2023.
- SSAP cannot be removed from the network; only seeking works, and breaks easily.
- Fetch/XHR patching must also cover the iframe trick: YouTube grabs a pristine `fetch`/`Request` from an `about:blank` iframe; AdGuard re-injects the patched `fetch`/`Request` into new iframes on `appendChild` [CHECKED]; uBO has `trusted-prevent-dom-bypass` for it. Needed in our MAIN-world script.
- Detection by wrapping natives (`Function.prototype.toString` checks) possible; mark wrappers native-looking.
- Licence: GPL scriptlets must not be copied; only the above facts (paths, URLs) are used.

### Sources
- https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt
- https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt
- https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/specific.txt (YouTube section approx. lines 960-1075)
- https://easylist.to/easylist/easylist.txt
- https://github.com/uBlockOrigin/uAssets/issues/30157 and /30158 and /28707
- https://adguard.com/en/blog/youtube-server-side-ad-insertion.html
- https://adguard.com/en/blog/youtube-new-banner-adblockers-violate-tos.html

### Not accessed / unknown
Reddit megathreads (blocked), AdGuard issue 203236 comments (only referenced in list comments), actual enforcement key names today, whether DOM skipping is detected, `/api/stats/ads` use. Nothing tested in a browser.

## C. What users complain about and what the Web Store requires

Date: 2026-11-14. Tags: CHECKED = I opened the source; REPORTED = a search snippet or secondary source says so; UNKNOWN = not found.
Limits: no `gh` CLI, so GitHub issues were read through the public API (counts below are comment counts, a proxy for demand). Reddit, HN and Web Store reviews were NOT reached (HN query failed; CWS review pages not opened). The ranking is therefore a judgement from issue activity plus secondary sources, not a measured frequency.

### C.1 Ranked complaints and wishes (MV3 blockers)

| # | Complaint / wish | Evidence | Status |
|---|---|---|---|
| 1 | Site-specific ads not blocked or sites broken ("site: ads", "site: breakage") | uBOL-home top threads: google.com breakage (93 comments, #476), news.com.au ads (49, #344), google.com ads (46, #574), screenrant breakage (45, #202), open.spotify.com ads (39, #293), steamcommunity breakage (28, #156). https://github.com/uBlockOrigin/uBOL-home/issues | CHECKED (API) |
| 2 | YouTube: ads return, "content isn't available", anti-adblock wall, video won't play | AdGuard ext: "Blocking Youtube Videos 'This content isn't available'" (29 comments, #3418; 16, #3421), "Adguard is not working on Youtube" (15, #3232), older anti-adblock wall thread (48, #2532). https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3418 . Ghostery blog on uBO and YouTube (vendor, biased): https://www.ghostery.com/blog/ublock-origin-not-working-on-youtube | CHECKED titles/counts; bodies not read |
| 3 | Cannot add own filter lists by URL / limited custom filters; cannot view or edit custom filters in dashboard | uBOL "Can I add my own blocklists? (by URL)" #167; "Allow viewing/editing custom filters from the dashboard" (22, #418). https://github.com/uBlockOrigin/uBOL-home/issues/167 , https://github.com/uBlockOrigin/uBOL-home/issues/418 | CHECKED (#167 body read) |
| 4 | No element picker / zapper (uBOL dropped it; asks to bring back "in a limited form") | uBOL #325 (27 comments, closed). Ghostery shipped an element picker PR in 2025 (#2391). https://github.com/uBlockOrigin/uBOL-home/issues/325 , https://github.com/ghostery/ghostery-extension/pull/2391 | CHECKED title/state; fix details not read |
| 5 | Stability and performance: popup stuck loading, extension freezes, cosmetic filters apply late, memory | AdGuard popup stuck on loader (71, #3400), extensions freeze (24, #3436), filters emptied in Chromium (25, #2955), memory leak (39, #2594). Ghostery "Cosmetic matching starts late on Chrome" (79, #3175). https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3400 , https://github.com/ghostery/ghostery-extension/issues/3175 | CHECKED titles/counts |
| 6 | Broad "read and change all your data" permission warning vs optional host permissions UX | uBOL #326 "Use host_permissions instead of optional_host_permissions" (19-33 comments): optional permissions caused "too many pain points" for deployment; uBOL moved to broad permission at install, with a setting to avoid it. https://github.com/uBlockOrigin/uBOL-home/issues/326 | CHECKED (body read) |
| 7 | Per-site toggle / status clarity (icon stays coloured when site is "no filtering") | uBOL "Show gray icon when not filtering" (35 comments, #198). https://github.com/uBlockOrigin/uBOL-home/issues/198 | CHECKED |
| 8 | Static rule limits / outdated lists (rules updated only with extension releases, review lag during anti-adblock waves) | Secondary: https://www.superchargebrowser.com/library/best-youtube-ad-blockers-chrome-2026/ ; https://www.standsapp.org/blog/ad-blockers-after-manifest-v3/ | REPORTED (vendor blogs, not verified) |
| 9 | Missing logger / blocked counts, advanced rules (`header=` etc. not translatable to DNR) | uBOL #157 "translate header= into DNR responseHeaders" (33 comments). https://github.com/uBlockOrigin/uBOL-home/issues/157 . AdGuard has a filtering log (issue 3564 shows it exists). | CHECKED title only |
| 10 | Cookie banners, Twitch ads | No dedicated top issue found in what I read. | UNKNOWN |

Note: many top uBOL threads are Safari-specific (#327, #358, #428); ignore for Chrome.

### C.2 Chrome Web Store requirements (2026-11-14)

Remote code policy (answer to the key question). CHECKED, page: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- "the full functionality of an extension must be easily discernible from its submitted code"
- External resources "must not contain any logic". Execution of logic from a remote source is allowed only via a documented API (Debugger API, User Scripts API).
- Extensions may load data from external sources if it contains no logic; remote config for enabling features is allowed when all logic ships in the package; fetching code or command strings for an interpreter is a violation.
- The page does not name filter lists. (The fetch tool summarised the page; I have not read the full original wording line by line.)
- Verdict: fetching filter lists as DATA and converting them in extension code into dynamic DNR rules is consistent with the policy text. Risks: (a) do not fetch scriptlet or JS snippets or anything executed; (b) declare honestly in the Privacy tab remote-code field; (c) reviewers may still flag it, so explain in the justification. Precedent: Ghostery uses a local DNR converter and dynamic DNR (PR #2568, #2593) https://github.com/ghostery/ghostery-extension/pull/2568 (REPORTED by title only).

Privacy tab (CHECKED, https://developer.chrome.com/docs/webstore/cws-dashboard-privacy):
- Single purpose description, narrow and easy to understand. Suggested: "Block ads, trackers and cookie banners on websites."
- A justification per permission (declarativeNetRequest, declarativeNetRequestFeedback, scripting, storage, `<all_urls>` host permissions). Remove permissions you do not use; excess permissions are treated as unrelated functionality (single purpose policy: https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq ).
- Declare remote code use and justify; undeclared remote code is rejected.
- Data-use disclosures plus limited-use certification; must be consistent with the privacy policy URL. Privacy policy link required (a policy stating "collects nothing, stays local" is the honest form if true).
- declarativeNetRequestFeedback is only needed for debugging and counts (getMatchedRules); drop it if not shipped, or justify it for the blocked-count display. (Judgement, not from policy.)

Review (CHECKED, https://developer.chrome.com/docs/webstore/review-process):
- Most reviews take a few days, up to a few weeks; contact support after 3 weeks.
- Broad host permissions (`<all_urls>`) and new developer/new extension extend review. Obfuscation is disallowed; minification can slow review.
- Rejection notice goes to publisher email with the violated policy and appeal info.

Account and fees:
- One-time registration fee is required (CHECKED, https://developer.chrome.com/docs/webstore/register). The amount is not on that page; $5 is the commonly cited figure (REPORTED via search result mentioning "$5 registration fee" on https://developer.chrome.com/docs/extensions/whats-new ; confirm in dashboard).
- 2-Step Verification required before publishing or updating (REPORTED via https://developer.chrome.com/docs/webstore/program-policies/policies and https://developer.chrome.com/blog/policy-update-2sv ).
- Developer email must be verified (CHECKED, https://developer.chrome.com/docs/webstore/set-up-account ).
- Trader / non-trader declaration is required for all developers (EU DSA). Traders must provide legal name, address, phone; shown publicly on the listing. Non-traders show a notice that consumer-protection rights do not apply. A free hobby extension is normally non-trader, but the page does not say so; it is the developer's responsibility to self-declare accurately (CHECKED, https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure ). Verification needs a payment profile (REPORTED, https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq ).

Listing assets (CHECKED, https://developer.chrome.com/docs/webstore/images):
- Icon 128x128 PNG in the zip (96x96 artwork + 16 px transparent padding), mandatory.
- Screenshots: 1 to 5, 1280x800 preferred or 640x400, full bleed, square corners; at least one mandatory.
- Small promo tile 440x280, optional (listings without one rank after those with one); marquee 1400x560 optional.
- Blank description, or missing icon or screenshots, is rejected (CHECKED, https://developer.chrome.com/docs/webstore/program-policies/listing-requirements).

Listing text rules (CHECKED, listing-requirements page above):
- Keyword spam: irrelevant or excessive keywords, lists of sites or brands without added value, same keyword repeated more than 5 times.
- Misleading or incomplete metadata (title, icon, screenshots, developer name) not allowed; no unattributed testimonials.
- Do not list "works with uBlock/AdBlock/YouTube/Twitch/Netflix" style site and brand lists; do not use others' brand names in the title. Impersonation policy page was not fetchable (404); this is a conservative judgement. Precedent: fake AdBlock Plus clones removed https://www.theregister.co.uk/AMP/2019/09/19/google_ad_blockers/ (REPORTED).

Common ad-blocker rejection experiences (REPORTED, snippets only, not opened):
- Spam / "additional functionality" rejections for DNR ad blockers: https://feedbagel.com/post/ask-hn-how-to-escalate-a-rejected-google-extension
- Vague rejection codes, forum: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/QVrNR320T3o
- uBlock Origin dev builds once rejected for single-purpose (secondary, REPORTED).
- Keyword spam policy origin: https://developer.chrome.com/blog/policy-update-kwspam-and-circumvention

### C.3 What distinguishes a top-rated blocker (not well evidenced)
I did not open any rating comparison or review corpus, so the AdGuard 9 / uBOL 8 / ABP lower split is UNKNOWN as a measured fact. Inferred from C.1 (judgement): users reward (1) real YouTube/anti-adblock handling, (2) custom filters + element picker + filtering log, (3) low breakage with an easy per-site pause and clear icon state, (4) no nag/acceptable-ads/paywall behaviour (not sourced), (5) a small permission story. Items to check next: CWS review pages for uBOL (https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh/support), AdGuard, ABP.

### C.4 Checklist for Ad Shield
- [ ] Name not containing "uBlock", "AdBlock", "AdGuard", "Ghostery", "Brave"; no brand/site lists in description.
- [ ] Single-purpose sentence; all permissions justified; drop declarativeNetRequestFeedback if unused.
- [ ] Remote code field: "No remote code executed; filter lists are fetched as plain-text data and converted by packaged code."
- [ ] Privacy policy URL (hosted page), data-use boxes all unchecked if nothing collected.
- [ ] Unminified/readable source or clean build; no obfuscation.
- [ ] Icon 128, 1-5 screenshots 1280x800, promo 440x280.
- [ ] Developer account: fee, 2SV, verified email, trader/non-trader declaration.
- [ ] Expect a longer review (broad host permissions, new account).

## D. Ranked plan (impact against risk)

Constraints set by the owner on 2026-11-14:
- free distribution only, so no Chrome Web Store account ($5) and no paid services;
- MIT licence, so ideas are reimplemented and no GPL code is copied;
- no telemetry and no remote config, except fetching the public lists themselves;
- the Twitch code is not touched.

| Rank | Item | Why | Risk | Decision |
|---|---|---|---|---|
| 1 | (a) Weekly list auto-update into dynamic DNR rules | Unpacked installs never update themselves, so the lists go stale. Dynamic rules allow 30,000 safe rules (Chrome 121+), and our converted lists produce about 14,800, all safe (block/allow/allowAllRequests). Downloading lists is data, not code. | Medium: a second converter could drift from the Python one. A golden-file parity test guards against that. | Build |
| 2 | (b) Own MAIN-world scriptlets, starting with YouTube | YouTube scores 3/10. Sections B and A.1 show that every working MV3 blocker relies on json-prune and set-constant style scriptlets. Only bundled code runs, and the rules file is packaged. | Medium-high: YouTube changes keys every few weeks, and SSAP ads cannot be pruned. | Build: the YouTube recipe phases 1-2, the anti-adblock (`onAbnormalityDetected`) defuse, and a small generic library (set-constant, abort-on-property-read/write, json-prune, prevent-setTimeout, prevent-fetch, remove-attr). |
| 3 | (c) Element picker and "My filters" | Ranked 3rd and 4th among user wishes (C.1). uBOL, AdGuard and Ghostery now all have one. | Low: the picker is injected only on click, and its CSS is stored locally. | Build |
| 4 | (d) `$removeparam` for tracking parameters | Cheap privacy win. DNR `queryTransform.removeParams` takes exact names only, with no wildcards (A.3), so `utm_*` is spelled out. | Low-medium: redirect rules are "unsafe" (5,000 limit), so they go in a static ruleset. Possible redirect loops are avoided with a regex condition so the rule only fires when a parameter is present. | Build, as a static ruleset with its own switch. |
| 5 | (e) Distribution | The Web Store is out (owner: free only). A clear INSTALL.txt in the zip covers Windows (Chrome, Edge, Brave) and macOS, and the README gets a privacy note. | None | Build |
| skip | Procedural cosmetics (`:has-text`, `:upward`) | They need a runtime engine in every page, which conflicts with "keep content scripts cheap". EasyList ships few of them (295 skipped filters in total, which also includes scriptlets). | | Later |
| skip | `$redirect` resources (noop.js, IMA stubs) | Useful against breakage, but EasyList uses few `$rewrite` filters (7 skipped). It matters more for uBO's own lists, which are GPL. | | Later |
| skip | Per-site filtering modes like uBOL's | Our allowlist already gives on/off per site, and the extra modes need optional host permissions. | | Later |
| skip | YouTube SSAP reload trick (B, phase 3) | Complex and account-dependent, and it changes the request identity. Too fragile to build without a real account to test on. | | Later |

## E. Results

_Filled in after the build: see docs/TESTING.md._
