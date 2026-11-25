# Architecture

Ad Shield has two independent parts: the **general blocker** (all sites; first section) and the
**Twitch video-ad module** (the rest of this document, unchanged). Both are switched by
`settings.enabled`; a site on the general allowlist is off for both.

## General blocker (all sites)

### Build time (`tools/`, Python 3 standard library, run by hand)

| File | Role |
|---|---|
| `tools/build_rules.py` | Downloads EasyList, EasyPrivacy and the EasyList Cookie List with `curl` (`--proto =https`) into a fresh `tempfile.mkdtemp()` folder (or `--lists DIR`), converts them, writes `rules/*.json`, `rules/cosmetic/*`, `rules/build-info.json` and the `rule_resources` list in `manifest.json`. Every build also builds the two curated rulesets from `rules/curated_hosts.txt` (checked before anything is downloaded or deleted). `--curated-only` rebuilds just those: `ads_curated.json`, `privacy_curated.json`, the manifest `rule_resources` and the `curated` / ruleset entries of `build-info.json`, with no download and without touching the other generated files. The cleanup of old output removes only numbered rulesets (`ads_[0-9]*.json`, ...). Manifest order: `client_ads`, `trackers`, `ads_N`, `ads_curated`, `privacy_N`, `privacy_curated`, `cookies_N`, `cookie_strip`. |
| `tools/curated.py` | Parser and rule generator for `rules/curated_hosts.txt` (pure functions). Sections `[ads]`, `[trackers]`, `[never]`; `#` comments; `-host` excludes a host (and its subdomains) from its section. Hosts must be lowercase ASCII/punycode with at least two labels; duplicates, unknown sections, empty sections and exclusions that exclude nothing are errors. The build fails if a `[never]` host is equal to or under a blocked host and not covered by an exclusion of that section. Each blocked section becomes one rule: id 1, priority 1, `block`, `requestDomains` (sorted), `domainType: thirdParty`, `excludedRequestDomains` when there are exclusions, no `resourceTypes` (so `main_frame` is never blocked). |
| `tools/filterlist.py` | Our converter (pure functions). Network filters: `\|\|`, `\|`, `^`, `*` patterns pass through to `urlFilter` (same syntax in DNR); `$third-party`/`first-party` -> `domainType`; resource types and `~type` -> `resourceTypes` / `excludedResourceTypes`; `domain=` -> `initiatorDomains` / `excludedInitiatorDomains` (IDN -> punycode); `match-case`; `important` (priority 3); `@@` -> `allow` (priority 2), `@@...$document` -> `allowAllRequests`; simple RE2-safe `/regex/` (capped at 200 per list). Plain `\|\|host^` filters with identical options are merged into `requestDomains` lists of 1,000 hosts. Block rule ids start at 1, allow rule ids at 500001 (`ALLOW_ID_BASE`, mirrored in `src/shared/blocking.js`) so counts can ignore allow matches. Rulesets are split at 30,000 rules. Cosmetic: `##` / `#@#`, `$generichide` / `$elemhide` for `\|\|host^`. Everything else raises `Skip(reason)` and is counted. |
| `tools/make_golden.py` | Writes `tests/fixtures/lists/golden.json`: what `build_rules.convert_texts` (the pure part of the build) makes of the fixture lists in `tests/fixtures/lists/`. `tests/test_rules.py` checks the golden equals the current Python output and `tests/filterlist.test.js` checks the JavaScript port produces exactly the same, so the two converters cannot drift. Rerun it (and port the change) after any converter change. |
| `tools/removeparam.py` | Parser and rule generator for `rules/removeparams.txt` (pure functions; names spelled out exactly, `#` comments, duplicates and generic names such as `ref`, `si`, `source`, `mkt_tok` are errors). Called by `tools/build_rules.py` (full build and `--curated-only`), which writes `rules/removeparam.json` and keeps it last in the manifest. |
| `tools/vendor_autoconsent.py` | Downloads the pinned `@duckduckgo/autoconsent` npm tarball (17.2.0), checks its sha512 against the registry's integrity value, copies four files unmodified into `vendor/autoconsent/` and records their sha256 in `VERSION.json` (the validator re-checks them). |

### Generated data (`rules/`, committed)

| File | Used by |
|---|---|
| `ads_N.json`, `privacy_N.json`, `cookies_N.json` | static DNR rulesets, toggled by Ads / Trackers / Cookie banners (hide) |
| `curated_hosts.txt` -> `ads_curated.json`, `privacy_curated.json` | our own hand-written host list (MIT): whole hosts that only serve ads / tracking, where EasyList / EasyPrivacy block only some paths or types. One third-party block rule per section (44 ad hosts; 45 tracker hosts, 1 exclusion; 23 `[never]` hosts checked). Toggled by Ads / Trackers and counted as ads / trackers, like `ads_N` / `privacy_N`. Priority 1, so EasyList `@@` exceptions and the allowlist still win. |
| `cookie_strip.json` | static `modifyHeaders` ruleset: removes `cookie` (request) and `set-cookie` (response) for `domainType: thirdParty` requests to hosts from EasyPrivacy `\|\|host^$third-party` filters (cap 10,000; 3,791 today). Same priority as block rules, so a blocked request stays blocked and an exception (`allow`, priority 2) also stops stripping. |
| `cosmetic/ads_generic.css`, `cosmetic/ads_generic_top.css`, `cosmetic/cookies_generic.css` | generic hiding, registered as content-script CSS, written by `tools/cosmetic.py` (also runnable alone to rebuild them offline from `generic.json`). EasyList's generic selectors (13,635, none tied to a site) are split in two tiers: `ads_generic.css` is the **core** for every frame: selectors made only of generic ad vocabulary (ad, ads, advert, sponsored, dfp, gpt, adsbygoogle ... plus position / container words such as top, sidebar, box, slot, wrapper, IAB sizes such as 300x250; tag and attribute names not counted), at most 4 words and 40 characters, ranked by word count then length, capped at 40,000 bytes (3,155 selectors, 42 KB). `ads_generic_top.css` holds every other generic ad selector (10,480, 182 KB) and `cookies_generic.css` the cookie list's (15,272, 314 KB); both run in the **top frame only**. Nothing is dropped: the top frame still gets every generic selector, sub-frames (ad iframes, embeds) parse 42 KB instead of 538 KB. Simple `#id` / `.class` selectors grouped 100 per rule, everything else one rule per selector (an invalid selector only drops itself). |
| `cosmetic/site.json` | site selectors per host (`ads`, `cookies`), exceptions per host, `genericExceptionHosts`, `generichide`, `elemhide` |
| `cosmetic/generic.json` | the generic selectors again, for hosts that have exceptions (loaded only for them) |
| `youtube.json` (hand-written) | static DNR ruleset `youtube`: blocks `\|\|youtube.com/pagead/` and `\|\|youtube.com/youtubei/v1/player/ad_break` (research-v2 B.5; never `/api/stats/` or `get_drm_license`). EasyList has both too; ours stays when the weekly update replaces `ads_N`. Toggled by Ads, counted as ads, last in the manifest; `tools/build_rules.py` keeps it (`HAND_RULESETS`), `tests/validate_manifest.py` pins its rules. Also adds `pp=oAEBogYBLg` to `www.youtube.com/watch` page loads (redirect, rule 3, not counted; an allow rule, 500001, for URLs that already have it stops a loop): uBO's "oaeb" player params, so the page's player response has no ad data and YouTube's stream skips its 4-9 s ad backoff (docs/DESIGN-v2.md). |
| `removeparams.txt` -> `removeparam.json` | our own tracking-parameter list (MIT, 46 names: UTM tags, ad click ids, e-mail tracking ids; each commented). Static ruleset `removeparam`, toggled by "Remove tracking parameters from links" (`stripTrackingParams`, default on), never counted in the popup. Two rules per name (`urlFilter` `?name=` and `&name=`, case-sensitive), each a `redirect` with `transform.queryTransform.removeParams` = all 46 names, `resourceTypes` `main_frame` + `sub_frame`, `excludedRequestDomains` `doubleclick.net`, `googleadservices.com` (click redirectors that pass the id on). A rule fires only when a listed name is present, so the redirect always changes the URL (no loop). Priority 50: above every list rule (1..4, so list `@@` exceptions do not stop it), below the allowlist rule (100). urlFilters instead of one alternation regex: Chrome compiles each `regexFilter` under a 2 KB RE2 memory limit. `tests/validate_manifest.py` allows redirect rules only here and checks this exact shape (`dnr_schema.removeparam_ruleset_errors`). |
| `cosmetic/youtube.css` (hand-written) | YouTube hiding, registered for YouTube hosts only (below) |
| `scriptlets.json` (hand-written) | our scriptlet rules (below) |
| `build-info.json` | list versions, rule counts, skipped filters by reason, `curated` host counts |

Total static rules today: 14,920 (14,918 enabled by default; 4 of them the hand-written `youtube` ruleset, 92 the `removeparam` ruleset), under `GUARANTEED_MINIMUM_STATIC_RULES` (30,000), so
the shared global pool is never needed; `tests/validate_manifest.py` enforces this, the regex
limit (1,000) and the ruleset count limits.

### Run time

| File | World / context | Role |
|---|---|---|
| `src/shared/blocking.js` | background, popup, options, ISOLATED bundle, tests | Storage key `blocking` (`ads`, `trackers`, `stripCookies`, `hideCookieBanners`, `autoRejectCookies`, `autoUpdateLists`, `scriptlets`, `stripTrackingParams`, `allowlist`), normalisation, allowlist matching, the dynamic rule id ranges of updated lists (`DYNAMIC_BASES`, `dynamicFeature`), and pure planners: `rulesetPlan` (takes the categories whose updated lists are installed), `allowlistRules`, `contentScriptPlan`, `cssForHost`, `countMatches`. |
| `src/shared/filterlist.js` | service worker, tests | JavaScript port of `tools/filterlist.py` + `build_rules.convert_texts` (network rules with domain merging, priorities, allow ids from 500001, RE2 safety check, regex cap, skip reasons; site-specific cosmetic data). Keeps Python semantics where they affect output (`str.strip`/`splitlines`, `json.dumps(sort_keys=True)` group keys, IDNA 2003 nameprep + punycode like Python's `idna` codec). Parity: `tests/filterlist.test.js` against `golden.json`; on the real lists of 2026-11-14 both converters gave identical rules, counts and site data (3,781 / 9,244 / 1,794 rules; jsc took about 0.3 s for all three). |
| `src/shared/lists.js` | service worker, options, tests | Pure decisions of the list update: list URLs, version parsing (`202611140001`, `2026-11-12 20:50 UTC`, `14 Nov 2026 00:01 UTC`), sanity checks, all-or-nothing decision, dynamic ids, limits, `isDue`, `shouldRevert`, status rows. |
| `src/background/general.js` | service worker | Owns every DNR change of the general blocker in one queue (`syncDnr`): `updateEnabledRulesets` for the general rulesets, one dynamic `allowAllRequests` rule (id 1, priority 100) for the allowlist, the dynamic rules of updated lists; `registerContentScripts` (skipped when the stored plan signature is unchanged). Handles `as-page` (inject site CSS with `insertCSS`, `origin: 'USER'`), `as-banner`, and autoconsent's messages. Site cosmetic data: `chrome.storage.local` `listSite` (updated lists) when present, else `rules/cosmetic/site.json`; other data is loaded from the package with `fetch(chrome.runtime.getURL(...))`. `installLists` / `resetLists` are the updater's entry points into the queue. |
| `src/background/updater.js` | service worker | Weekly list update (below). The only code that makes network requests. |
| `src/background/autoconsent-shim.js` + `vendor/autoconsent/autoconsent.cjs.js` | service worker | `module`/`exports` objects so the unmodified CommonJS build loads with `importScripts`; `general.js` uses its `evalSnippets` and `filterCompactRules`. A load failure only disables auto-reject. |
| `src/scriptlets/lib.js`, `src/scriptlets/runner.js` -> `build/scriptlets-main.js` | MAIN, all frames, document_start, YouTube hosts only | Our scriptlets (section below). |
| `src/content/general.js` | ISOLATED, top frame, document_start | Sends `as-page` with the host and `performance.timeOrigin`; once after `load` + 1.5 s (idle callback) checks this site's cookie selectors with `querySelector` and reports one `as-banner` if one matched. No observers, no repeating timers. |
| `vendor/autoconsent/content.bundle.js` | ISOLATED, all frames | autoconsent, registered only while auto-reject is on. |
| `src/shared/userfilters.js` | background, options, tests | "My filters" (section below): storage key `userFilters`, normalisation, caps, the `host##selector` text format, the conservative selector syntax check, `cssFor(host)`. |
| `src/shared/selector.js` + `src/content/picker.js` | ISOLATED, top frame, injected on click only | The element picker (section below). Never registered as a content script. |

Registered content scripts (ids start with `as-`; the Twitch ones stay in `manifest.json`):

| Id | What | Frames | Excluded |
|---|---|---|---|
| `as-css-ads` | `rules/cosmetic/ads_generic.css` (generic ad core) | all | allowlist + exception hosts |
| `as-css-ads-top` | `rules/cosmetic/ads_generic_top.css` (other generic ad selectors) | top | allowlist + exception hosts |
| `as-css-cookies` | `rules/cosmetic/cookies_generic.css` | top | allowlist + exception hosts |
| `as-site` | `src/content/general.js` (all sites while Ads or Cookie banners (hide) is on; otherwise only the hosts that have "My filters") | top | allowlist |
| `as-autoconsent` | `vendor/autoconsent/content.bundle.js` (`matchOriginAsFallback`) | all | allowlist |
| `as-css-youtube` | `rules/cosmetic/youtube.css`, matches `youtube.com`, `youtube-nocookie.com`, `youtubekids.com` (`YOUTUBE_CSS_HOSTS`) | all | allowlist |
| `as-scriptlets` | `build/scriptlets-main.js`, `world: 'MAIN'`, no `matchOriginAsFallback` (sandboxed about:blank frames on YouTube logged errors; same-origin blank children are patched from the parent), matches only the hosts of `rules/scriptlets.json` | all | allowlist |

Exception hosts (sites with `#@#` exceptions for generic selectors, `$generichide`, `$elemhide`)
are excluded from the static CSS; for them the background injects the generic selectors minus
the exceptions (none for `generichide`, nothing at all for `elemhide`).

### Scriptlets (`src/scriptlets/`, `rules/scriptlets.json`)

Small patches of page APIs that must run in the page's own JavaScript world before the site's
code: what DNR and CSS cannot do (edit JSON the page receives, trap globals, neuter callbacks).
Our own code (MIT), written from the behaviour descriptions in research-v2 A.1; no uBO / uBOL /
AdGuard code (GPL).

- **Library** `src/scriptlets/lib.js`: `set-constant`, `abort-on-property-read`,
  `abort-on-property-write`, `json-prune`, `json-prune-fetch-response`, `json-prune-xhr-response`,
  `prune-on-assign`, `prevent-fetch`, `prevent-setTimeout`, `adjust-setTimeout`,
  `prevent-promise-then-callback`, `remove-attr`, `remove-class`, `youtube-ad-skip`,
  `youtube-enforcement-dismiss`. Each is `fn(win, args, log)` and only touches `win.X`, so tests
  use fake windows and child frames can be patched too. Argument syntax (paths with `[]`, `[-]`,
  leading `..`; URL / needle as substring or `/regex/`) is documented at the top of the file.
  Patched functions are Proxies of the originals (name and length kept) with a non-enumerable
  own `toString` (a bound `Function.prototype.toString` of the original), so `fn.toString()` and
  `String(fn)` show the original source; `Function.prototype.toString` itself is not hooked
  (2.0: a realm-wide proxy cost every `toString` call). Every hook catches
  its own errors and falls back to the original behaviour; the fetch / XHR pruning returns the
  original response when nothing was removed or the body is not JSON, and otherwise a new
  `Response` with the original status, status text, headers (minus `content-length`), `url`,
  `type` and `redirected`. XHR: `response` / `responseText` are overridden on the instance, only
  for requests whose URL matches.
- **Child frames**: a page can take a clean `fetch` / `JSON` / `Promise` from a fresh
  `about:blank` iframe before any content script runs there (research-v2 B, Risks). The runner
  hooks `HTMLIFrameElement.prototype.contentWindow` / `contentDocument`; the first access to a
  same-origin frame's document re-applies the scriptlets marked `fn.frames` (the fetch / XHR /
  JSON / Promise / timer ones) to that frame, recursively. Not covered: `window.frames[i]`.
- **Runner** `src/scriptlets/runner.js`: picks the rules whose `hosts` cover `location.hostname`
  (host or a parent domain; `notyoutube.com` does not match `youtube.com`); `about:blank` /
  `srcdoc` frames use `document.domain` / `self.origin`.
- **Delivery**: `tools/build.py` checks `rules/scriptlets.json` (hosts, known scriptlet names,
  string arguments; a bad rule fails the build) and writes `build/scriptlets-main.js` = lib +
  runner + the rules as JSON, inside one function scope (no page globals). `general.js` loads
  the packaged `rules/scriptlets.json`, `blocking.scriptletHosts` turns it into match patterns
  and `contentScriptPlan` registers `as-scriptlets` (MAIN world) for those hosts only, so other
  sites pay nothing. On while the master switch, Ads and "Fix YouTube ads and anti-adblock walls
  (page scripts)" (`blocking.scriptlets`, default on) are on; allowlisted sites are excluded.
  Shipped in the package only, never downloaded, no telemetry.
- **Cost on YouTube** (2.0, docs/DESIGN-v2.md: fewer, cheaper hooks against short FPS dips):
  one ~35 KB script per frame at document_start. No hook on `Promise.prototype.then` or
  `Function.prototype.toString`. Every pruner first looks for its needle words (the last key of
  each path: `adPlacements`, `adSlots`, `playerAds`, `isAd`) in the JSON text with a plain
  `indexOf`; a text without any is not pruned at all (`JSON.parse` returns the native result,
  primitives are returned before any check; a matching youtubei fetch / XHR body is not parsed,
  and the fetch `Response` comes back as the same object). Otherwise `JSON.parse` /
  `Response.json` check a few top-level keys per call (no deep walk: the feed `json-prune` is
  gone). A deep (`..`) path walks a parsed body only when its own needle is in the text (the
  Shorts `isAd` path in the fetch / XHR pruners). Only the youtubei player, get_watch, playlist,
  resolve_url and Shorts sequence responses are read at all (not next / browse / search, the
  large feed bodies); matching ones with a needle are parsed and re-serialised once, and
  `Response.json` of such an already pruned copy is not pruned again. `youtube-ad-skip`: two capture listeners
  (`loadedmetadata`, `playing`) and one MutationObserver per player on its `class` attribute; no
  timers, no polling. `youtube-enforcement-dismiss`: two capture listeners (`animationstart`,
  `pause`) and a wrapper around `navigator.mediaSession.setActionHandler`; a `pause` costs one
  `querySelector`; no observer, no polling. `adjust-setTimeout`: one delay compare per
  `setTimeout` call; the callback source is read only when the delay matches. `remove-attr` / `remove-class` (not used by the YouTube rules) observe for
  at most 10 s (or until 3 s after `load`), re-running at most every 100 ms.

The YouTube rules (research-v2 B recipe 1-7 and 11):

| Scriptlet | What |
|---|---|
| `prune-on-assign ytInitialPlayerResponse` | setter trap: the page-embedded player response loses `adPlacements`, `adSlots`, `playerAds` |
| `prune-on-assign ytInitialData` | feed / search / watch-next / Shorts ad items removed from the initial data (one-time; the only feed pruning: later feed pages are left to `youtube.css`) |
| `json-prune` (player keys) | every `JSON.parse` / `Response.json`: top-level, `playerResponse.` and `[].playerResponse.` ad keys, after the needle check |
| `json-prune-fetch-response`, `json-prune-xhr-response` | player keys plus `..entries.[-].command.reelWatchEndpoint.adClientParams.isAd` (Shorts), for `/youtubei/v1/(player\|get_watch\|playlist\|(navigation/)?resolve_url\|reel/reel_watch_sequence\|reel/reel_item_watch)` (uBO's URL set) |
| `adjust-setTimeout [native code] 17000 0.001` | the 17 s "fake buffering" wait of flagged accounts (research-v2 B section 1): a `setTimeout` with delay exactly 17000 and a native-code callback (e.g. a bound function) runs after 17 ms. Generic arguments: needle (source substring or `/regex/`), delay (`''` = any), factor (clamped to 0.001-50, default 0.05). Not re-applied to child frames |
| `prevent-dom-bypass Node.prototype.appendChild "fetch Request"` | after `appendChild` inserts an iframe (or a node / fragment holding one), the frame's `fetch` and `Request` become this window's (wrapped) ones, so a clean pair taken from a fresh frame still passes through pruning and body edits, however the frame's window is reached (uBO `trusted-prevent-dom-bypass`). Same-origin frames only |
| `remove-node-text script 'window,"fetch"'` | inline scripts containing `window,"fetch"` are emptied and removed by a MutationObserver before they run (uBO `rmnt`); the observer stops at DOMContentLoaded |
| `youtube-drop-player-event onAbnormalityDetected` | the player's `onAbnormalityDetected` event (published on an ad context in the SABR stream for a response without a pre-roll, an untrusted Skip click, an ad finished too fast; the main app's listener stops the video and shows the enforcement message) never reaches a listener: the player copies its API onto its element (`element[name] = fn`), an accessor for `getApiInterface` on `HTMLElement.prototype` notices that and wraps that element's `addEventListener`, dropping subscriptions to the event. No `Promise.prototype.then` hook (uBO uses one) |
| `youtube-ad-skip` (youtube.com) | `.html5-video-player.ad-showing`: mute, seek the ad to its end; unmute after. Skip is not clicked (since 2.0): the player answers a script's (untrusted) click with `onAbnormalityDetected` instead of skipping. At most one seek per ad (per video `src` + duration, forgotten when `ad-showing` clears): the class observer also fires on `ytp-autohide` etc., and repeated seeks into the MSE stream stalled playback (1.1.5). No seek when the ad is longer than 90 s (a stitched stream whose end is the end of the video) or in the content stream (same `src` as the content, or `getStatsForNerds().debug_info` starts with `SSAP`, asked only right before a seek): seeking there would skip the video |
| `youtube-enforcement-dismiss` (youtube.com) | The anti-adblock dialog (`ytd-enforcement-message-view-model` in a modal `tp-yt-paper-dialog`, research-v2 B.3) is closed, not hidden: hiding it with CSS (up to 1.1.0) left its scroll lock, backdrop and forced pauses in place. Detected by `animationstart` of a 1 ms animation `as-yt-enf` that `youtube.css` gives the element, or on a player `pause`. Calls the dialog's `close()` (else removes it), closes an opened `tp-yt-iron-overlay-backdrop`, clears `overflow:hidden` on html / body and `no-scroll` on html / body / `ytd-app`. While the dialog is open, or within 3 s after it was last found open (and closed), a player video that pauses without user activation (`navigator.userActivation.isActive` false; no resume if the API is missing), not ended, not `seeking`, with `readyState` >= 3 and no ad showing, is resumed with `play()`, at most 3 times per 10 s. Other pauses are the player's own (source / quality switches, ad -> content, seeks): up to 1.1.4 they were resumed for the rest of the page once a dialog had been seen, which put audio and video out of sync. Not resumed within 1.5 s of a `navigator.mediaSession` action handler call (`pause`, `play`, `stop`, `seekto`, `previoustrack`, `nexttrack`: media keys, headphones, picture-in-picture), so those pauses stay the viewer's; `setActionHandler` is wrapped on the `MediaSession` prototype and keeps its native look |

Removed in 2.0 (docs/DESIGN-v2.md): `prevent-promise-then-callback
onAbnormalityDetected` (a Proxy on every `Promise.prototype.then`; the scriptlet stays in the
library, unused; `youtube-drop-player-event` replaces it), `set-constant ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch false`, and the
`JSON.parse` feed `json-prune` (`responseContext`) that walked every large API response.

Not done (research-v2 B): client-variant rotation against "fake buffering" (phase 3), text
renaming of ad keys in unparsable bodies, `muteOnStart` / `youThereRenderer` removal, generic
anti-adblock rules for other sites.

**How to add a rule**: add an entry `{ "id", "about", "hosts": [...], "scriptlets": [[name,
...args]] }` to `rules/scriptlets.json` (hosts: plain lowercase domains, each covers its
subdomains), run `python3 tools/build.py` and `bash tests/run.sh`, reload the extension. New hosts
are registered automatically (the plan signature changes). A new scriptlet goes into the table
at the end of `lib.js` with a test in `tests/scriptlets.test.js`; set `fn.frames = true` if it
patches window-level APIs that a child frame could hand out.

### Element picker and "My filters"

- **Start**: the popup button "Hide an element on this page" (shown on http(s) pages while Ad
  Shield and the site switch are on) calls `chrome.scripting.executeScript` with
  `files: ['src/shared/selector.js', 'src/content/picker.js']` on the tab's top frame (ISOLATED
  world) and closes the popup. Nothing is injected until that click.
- **UI** (`src/content/picker.js`): one `<as-picker>` element on `<html>` (fixed, full viewport,
  z-index 2147483647, `pointer-events: none`, inline `!important` styles) with a closed shadow
  root holding the highlight box and the panel. All styles are set through CSSOM
  (`element.style`), which page CSP does not block. Mouse events on the page are swallowed
  while picking (capture listeners on `window`); a click picks the element. The panel shows the
  selector (editable), "Wider" / "Narrower" (parent / back towards the picked element), "Move
  panel", "Hide" (also Enter), "Cancel" (also Esc). Preview: every match is hidden with an
  inline `display: none !important` and the count is shown; selectors matching `<html>`,
  `<body>` or the picker itself are refused. Quitting restores the inline styles.
- **Selector** (`src/shared/selector.js`, tested pure parts): ids and classes that look generated
  are skipped (`looksRandom`: 4+ digit runs, hex / mixed-case hashes, `css-` / `jsx-` / `sc-`
  prefixes, CSS-modules `__hash` suffixes, names over 40 characters, names needing escapes).
  Order: unique `#id`, unique `tag.class` (one or two classes), else a `>` path of
  `tag.class` / `tag:nth-of-type(n)` steps up to an ancestor with a unique step (at most 8
  steps), shortened from the left while it still matches only the picked element. The result
  is checked with `querySelectorAll`.
- **Save**: `{type: 'as-picker-save', selector}` to the background. The site is the sender
  tab's host (`siteKey`, without `www.`), not a value from the page; top frame only. The
  selector gets the conservative check (`userFilters.selectorError`: no `{ } ;` outside quotes,
  no comments, no at-rules, no control characters, balanced brackets and quotes, at most 500
  characters), is stored and inserted into the tab at once (`insertCSS`, `origin: 'USER'`)
  unless the master switch is off or the site is allowlisted.
- **Storage**: `chrome.storage.local` `userFilters` = `{ "example.com": ["selector", ...] }`
  (a host covers its subdomains). Caps: 200 selectors per site, 5,000 in all, 500 characters
  each. Per site only: there are no global user filters (a line without a site is rejected).
- **Applied**: on every page load the `as-page` hello also injects the user's selectors for the
  host and its parent domains, one rule per selector (an invalid one only drops itself),
  whenever the master switch is on and the site is not allowlisted, also with Ads and Cookie
  banners (hide) off (then `as-site` is registered for the hosts with user filters only). Top
  frame only, like the site-specific list CSS.
- **Options page** "My filters": a textarea in `example.com##.selector` format (one per line,
  `a.com,b.com##sel` for several sites, `!` comments are accepted but not stored). Save checks
  every line (site, the conservative check and the browser's own parser) and lists errors per
  line; nothing is saved while there are errors. Picker saves show up there.
- **Limits**: top frame only (no iframes, no shadow DOM content); elements hidden by `display`
  only; selectors with generated names are avoided but a site redesign can still break one;
  a page's own window capture listeners registered before the picker still see its events.

### Weekly filter-list update (`src/background/updater.js`)

- **When**: a `chrome.alarms` alarm `as-lists-weekly` (every 7 days) while `autoUpdateLists` (option
  "Update filter lists automatically", default on) and the master switch are on; on install,
  startup and settings changes the alarm is (re)created and, if a check is due (`lists.isDue`: the
  last check is a week old, or, before the first check, the lists in use are a week old), a one-shot
  `as-lists-soon` alarm runs it a minute later. Off: both alarms are cleared and nothing is fetched;
  the lists in use stay until "Use built-in lists". "Update now" on the options page always runs.
- **Requests**: `GET` of the three URLs in `lists.js` (the ones `tools/build_rules.py` uses), https
  only, `credentials: 'omit'`, `cache: 'no-cache'`, 60 s timeout (`AbortController`), 15 MB cap
  (read as a stream). No other requests, nothing sent, no telemetry, no remote config.
- **Checks (all or nothing)**: all three must download (HTTP 200), have a `! Version:` or
  `! Last modified:` header, convert to at least 60 % of the packaged rule count of that list
  (`build-info.json`), and not be older than the version in use; at least one must be newer (else
  "Already up to date"). Regex rules `isRegexSupported` rejects are dropped. All three categories
  together (plus the allowlist rule) must fit `MAX_NUMBER_OF_DYNAMIC_RULES` (Chrome 121+: 30,000
  "safe" rules; Chrome 120: `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES`, 5,000, so updates do not fit
  there), `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` and `MAX_NUMBER_OF_REGEX_RULES`; today about
  14,800 rules, 11 regex, none unsafe. All or nothing because the site cosmetic data merges all
  three lists (exceptions, `generichide`), so a partial update would mix versions; any failure
  keeps everything in use and records the error per list.
- **Install**: rule id = category base + static id: ads 1,000,001+ (allow 1,500,001+), trackers
  2,000,001+ (2,500,001+), cookie banners 3,000,001+ (3,500,001+); id 1 stays the allowlist.
  `general.installLists` replaces all three categories in **one atomic `updateDynamicRules`**, then
  stores `listRules`, `listSite`, `lists`; if Chrome refuses, nothing is stored and the previous
  dynamic rules stay. While a category's dynamic rules are installed, its list rulesets (`ads_N`,
  `privacy_N`, `cookies_N`) are disabled; `ads_curated`, `privacy_curated`, `cookie_strip`,
  `client_ads` and `trackers` are never touched (cookie stripping keeps the packaged host list).
  Order inside `syncDnr`: static rulesets of categories that stay/become static are enabled first,
  then the dynamic update, then the rulesets of categories now dynamic are disabled, so there is no
  gap without rules.
- **Switched-off categories**: the converted rules are stored in `chrome.storage.local`
  `listRules` (~3.7 MB; `unlimitedStorage` gives headroom next to the 10 MB default quota).
  Ads / Trackers / Cookie banners (hide) off, or the master switch off, removes that category's
  dynamic rules; switching it on re-adds them from storage, with no download and no re-conversion.
  Chose this over caching the raw lists (~4.5 MB) because re-adding is then a plain copy and the
  stored rules are exactly what passed the checks.
- **Cosmetic**: the updated site-specific data (`listSite`, shape of `site.json`) replaces
  `rules/cosmetic/site.json` for the `as-page` CSS and the static-CSS exclusions. Generic hiding
  (`*_generic.css`, `generic.json`) is **not** updated and stays from the package; hosts whose
  exceptions hide packaged generic selectors are kept in `genericExceptionHosts`.
- **Extension update**: `onInstalled` with reason `update` falls back to the packaged lists
  (`resetLists`) when a packaged list version is newer than the updated one.
- **Metadata** `chrome.storage.local` `lists`: `{source: 'packaged'|'updated', lastCheck,
  lastResult: {ok, message, at}, lists: {<key>: {version, fetchedAt, rules, ok, error}}}`.
- **Messages** (only from extension pages: `sender.id` is ours, the URL is ours, and no tab or the
  options page): `as-lists-status`, `as-lists-update-now`, `as-lists-reset` ("Use built-in lists").

### autoconsent protocol (from its `docs/api.md` and `lib/messages.ts`)

| Content script sends | Background does |
|---|---|
| `init` | replies `initResp` via `tabs.sendMessage(tabId, …, {frameId})` with `rules: {autoconsent: [], compact: filterCompactRules(rules, {url, mainFrame})}` and a config with `autoAction: 'optOut'`, prehide and cosmetic rules on, heuristics and the popup MutationObserver off. `enabled: false` when auto-reject is off, the master switch is off or the tab's site is allowlisted. |
| `eval` (`snippetId`) | `scripting.executeScript({world: 'MAIN', func: evalSnippets[snippetId]})` in that frame, replies `evalResp {id, result}`; unknown snippet: `result: false`. No string is ever evaluated. |
| `autoconsentDone` | counts one rejected banner for the page |
| `cmpDetected`, `popupFound`, `optOutResult`, `selfTestResult`, `report`, … | ignored (autoAction is set, so no `optOut` command is needed) |
| `runtime.connect({name: 'instance-…'})` | accepted and closed at once |

### Counts

The popup calls `declarativeNetRequest.getMatchedRules({tabId, minTimeStamp: page start})`
(needs `declarativeNetRequestFeedback`; 20 calls per 10 min, so once per popup open, at most
every 5 s) and `blocking.countMatches` groups by ruleset id: `ads_N`/`ads_curated` -> ads,
`privacy_N`/`privacy_curated`/`trackers` -> trackers, `cookie_strip` -> cookies stripped, `cookies_*` -> banners;
rule ids >= 500000 (allow rules) are ignored. Matches of updated lists (`rulesetId: '_dynamic'`)
are grouped by id range (1,000,001+ ads, 2,000,001+ trackers, 3,000,001+ banners; the allow halves
of each range and the allowlist rule id 1 are ignored). Banners also add the
page's `hidden` and `rejected` counts from `chrome.storage.session` key `page:<tabId>`. The badge
is Chrome's own action count (`setExtensionActionOptions({displayActionCountAsBadgeText: true})`).
`onRuleMatchedDebug` was not used: it wakes the service worker for every matched request.

## Twitch video-ad module

Twitch Ad Shield is plain JavaScript loaded as classic scripts; there is no bundler. Every file
attaches what it exports to one namespace object, `__TAS__`, on its global (window, isolated
world, service worker, or the jsc test shell). In the page's MAIN world, `page.js` copies the
references it needs and deletes the namespace again, so the page's global object is left
almost untouched.

## Modules

| File | World / context | Role |
|---|---|---|
| `src/config.js` | all | **Single source of truth** for everything Twitch can change (markers, ignored DATERANGE classes, ad segment patterns, persisted query hash, Client-ID, backup order, usher URL patterns, timeouts, limits, selectors). JSON-serialisable and deep-frozen. Each value is commented with its source. |
| `src/shared/settings.js` | all | Defaults, `normalize` (never throws), `validate`, playerType list validation. |
| `src/shared/logger.js` | all, inlined in worker | `[TAS]` logger; debug/info only when debug is on. |
| `src/shared/frame.js` | MAIN, ISOLATED | Run in top frame and Twitch player sub-frames only; skip clips. |
| `src/shared/stats.js` | background, bridge, popup | Event → counter mapping, badge text, event and toast texts, popup status logic. |
| `src/core/m3u8.js` | MAIN, inlined in worker, tests | Pure HLS functions: `hasAds`, `isMidroll`, `classifyDateranges`, `stripAds`, `parseMedia`, `resequence`, `parseMaster`, `pickVariant`, `filterMasterCodecs`, `buildUsherUrl`, `matchUsher`, `isAdSegmentUrl`. No DOM, no `URL`, no `chrome.*`. |
| `src/core/gql.js` | MAIN, tests | PlaybackAccessToken body/headers, header capture, playerType rewrite, token parsing. |
| `src/core/processor.js` | inlined in worker, tests | The backup / strip state machine with injected `fetchText`, `getToken`, `now`, `emit`, `setTimeout`: poll deadline, single-flight search, ordered answers, renumbering. |
| `src/worker/worker-main.js` | inlined in worker | Replaces the worker's `fetch`, talks to the page, serves blank ad-segment answers. |
| `src/core/worker-source.js` | MAIN, tests | Builds the replacement worker source from the factories' `toString()` plus JSON data plus Twitch's original source. |
| `src/page/health.js` | MAIN | Playback metrics while the video plays (debug-only `health` events) and the one gated pause/play nudge after a playlist switch (2.0; replaced `recovery.js`). |
| `src/page/page.js` | MAIN | fetch hook, Worker hook, token requests, event relay. |
| `src/content/bridge.js` | ISOLATED | Settings to the page, events to the background, toast, popup status answers. |
| `src/content/cosmetic.js` | ISOLATED | Hides/mutes/pauses standalone ad `<video>` elements; hides display-ad containers beside the player and mutes/pauses videos in them. |
| `src/background/service-worker.js` | service worker | Settings defaults, script registration, DNR rulesets, stats, badge. |
| `src/popup/*`, `src/options/*`, `src/ui/common.css` | extension pages | UI. Light/dark via `prefers-color-scheme`, no external resources. |
| `rules/client_ads.json`, `rules/trackers.json` | DNR | Static rules, toggled with `updateEnabledRulesets`. `client_ads` (on with the master switch): allow rules, priority 5, so Twitch's client-side ad requests (`edge.ads.twitch.tv`, Amazon `vaes` ad path) from twitch.tv pages never fail on live streams although EasyList blocks them; VOD ad requests are answered in the page / worker (`settings.blockClientAds`). `trackers`: block rules, off by default. |

### Inlining into the worker

The video worker is created by Twitch from a blob URL; content scripts cannot run there. The
factories `tasM3u8Factory`, `tasProcessorFactory`, `tasLoggerFactory` and `tasWorkerMain` are
written without any outer-scope references, so their `Function.prototype.toString()` output is
a complete program. `worker-source.js` produces:

```
["use strict";]                       (only if Twitch's worker starts with it)
/* __TAS_WORKER__ */                  (marker: never wrap twice)
;(function () {
  var cfg = {...}; var boot = {settings};
  var M = (factory)(); var createProcessor = (factory)(); var createLogger = (factory)();
  (workerMain)(self, cfg, boot, M, createProcessor, createLogger);   // in try/catch
})();
<Twitch's original worker source>
```

No `eval`, no remote code, no `web_accessible_resources`. `tests/syntax.test.js` checks the
factories are self-contained and `tests/worker.test.js` compiles and runs the generated source
against a fake worker global; the smoke test runs it in a real Chrome worker.

## Data flow

1. **Install / startup** – the service worker normalises settings and registers two content
   scripts with `chrome.scripting.registerContentScripts` (`persistAcrossSessions: true`,
   `runAt: document_start`, `allFrames: true`, matches `https://*.twitch.tv/*`, excludes
   `https://clips.twitch.tv/*`): `tas-page-main` (MAIN world) and `tas-bridge-isolated`
   (ISOLATED world). On update it re-registers, so new files apply automatically. Turning the
   extension off unregisters both and disables both rulesets.
2. **Page load** – `page.js` runs before Twitch's code. Defaults are available synchronously.
   It hooks `fetch` and replaces `Worker` with a subclass, then says `hello`. The bridge reads
   `chrome.storage.local` and sends the settings as a `tas:to-page` CustomEvent (payload is a
   JSON string). The bridge also pings, so the handshake works whichever script runs first.
   Settings arrive milliseconds after start, long before the player creates its worker;
   workers that already exist get them by message.
3. **Page token request** – the fetch hook copies `Client-ID`, `Device-ID`/`X-Device-Id`,
   `Authorization`, `Client-Integrity`, `Client-Version`, `Client-Session-Id` from requests to
   `gql.twitch.tv`, and rewrites the page's own live `PlaybackAccessToken` from `playerType:
   "site"` to `"popout"` (research-technique.md §3.7). Embed, picture-by-picture and VOD token
   requests are left alone (a deliberate narrowing of what vaft does).
4. **Worker creation** – for a Twitch-origin worker URL the subclass reads the original source
   with a synchronous XHR, builds the new blob and calls `super()` with it. If anything fails it
   calls `super()` with the original URL, so Twitch's player always gets a worker.
5. **Usher master** – the worker drops `parent_domains` from the request, then remembers every
   variant URL with its resolution, frame rate and codecs. With *Prefer AVC* it removes HEVC/AV1
   variants (and their rendition groups) when AVC exists.
6. **Media playlist** – see the algorithm in the README. Messages worker → page:
   `token-request`, `event`; page → worker: `token-response`, `settings`. All carry
   the key `__tas_v1`; our listeners are registered first and call `stopImmediatePropagation`
   so Twitch's handlers never see them.
7. **Events** – worker → page (`health.onEvent`) → bridge (toast) → background (stats,
   badge, last event). Each break counts once: `ad-detected`, then `ad-blocked-backup` and/or
   `ad-stripped` or `ad-unremovable`, then `ad-end`.

## Adaptation points

All in `src/config.js`, see the README table. Code places that encode Twitch structure beyond
config values:

- `m3u8.stripAds` – the segment model (EXTINF title `live`, CUE-OUT/IN, DATERANGE classes).
- `gql.buildTokenBody` – persisted-query body shape.

## Recovery strategy

- **Never break the player**: every hook is in `try/catch`; on an internal exception the original
  request/response passes through untouched (`failure` event). The Worker hook falls back to the
  original URL; the worker prelude is wrapped so Twitch's code still runs if our install fails.
- **Playback health** (`health.js`, numbers in `config.health`; docs/DESIGN-v2.md): no seeks,
  no reloads, no localStorage writes, no strip-only "degraded" mode (all removed in 2.0). While
  the main `<video>` (blob: source) plays, one sample every 2 s (no timer otherwise): playhead
  advance, `waiting` events, dropped/total frames, `videoHeight`, paused time; a `health` event
  at most every 30 s, forwarded to the bridge only with debug on. The one nudge: within 30 s of
  a `playlist-switch`, tab visible, video playing, playhead frozen 5 s with >= 1 s buffered
  ahead, no click/key on the player in the last 1.5 s -> `pause()` then `play()`; at most once
  per ad break (`ad-detected` starts one) and once per 60 s. A rejected `play()` is not retried.
- **Backup lockouts**: a player type that fails or has its own ad is skipped for 5 s; at most 5
  types per search; backup masters cached 60 s per type (the type being served keeps its master
  while its media fetch works, so a steady-state backup poll is one fetch); the last working
  type is tried first. Default order `popout, embed, site, mobile_web` (no 360p `autoplay`; the
  1.x default stored on install is migrated by `settings.normalize`). A backup is used only at
  the exact `RESOLUTION` (width and height) and codec family of the variant the player chose
  (`m3u8.pickVariant`); a type without one is skipped for that poll (no lockout). Among those,
  equal `FRAME-RATE`, then the native `CODECS` string wins.
- **Poll deadline** (`backupPollDeadlineMs`, 1.8 s): a media poll waits at most this long for the
  backup search, then gets the stripped playlist; the search goes on in the background, one
  per channel (later polls join it). No hold and no replay of an older playlist: a missed poll
  gets the stripped native playlist. Leaving a backup needs 2 clean native polls in a row.
- **Order**: per channel, answers leave in request order and their state changes (switch
  events, numbering) happen in that order, so a slow older answer never overtakes a newer one.
- **Numbering** (`m3u8.resequence`, research-2026-11-13.md C1/F1/F2): once a live playlist has
  been rewritten, every answer for it is renumbered from per-playlist state. A segment is
  identified by its live number (`#EXT-X-TWITCH-LIVE-SEQUENCE` + index, up to the first
  discontinuity) where known, else by URL, and keeps the number it was first given; a segment
  the player already has (same live number, or ending before what was given) is never listed
  again under a new number, so native <-> backup switches do not make the player download a
  segment twice (the cause of the ~2 s/midroll audio drift). New segments get the next number:
  `MEDIA-SEQUENCE` and `DISCONTINUITY-SEQUENCE` are continuous and monotonic. A
  `#EXT-X-DISCONTINUITY` goes before the first new segment after a source change (native,
  `backup:<type>:<resolution>:<fps>:<codecs>`), a live-number or date-time gap, or where the
  source had one. If an appended segment still overlaps what was given (no live numbers, dates
  off by more than 0.5 s), the worker posts `segment-repeat` (once per 20 s per channel).
  fMP4 channels (`#EXT-X-MAP` init segments): `parseMedia` gives each segment the MAP in force
  for it, and the sequencer keeps it per window entry. The served playlist never takes MAP from
  the header: the entry's MAP goes before the first listed segment, after every DISCONTINUITY
  and wherever it changes (a change also forces a DISCONTINUITY), so backup segments are never
  decoded with the native init segment or the other way round (picture lost, audio plays).
  `stripAds` never writes an ad's MAP; a live segment after an ad gets its live MAP again.
  Playlists never rewritten pass through untouched. Known limit: numbering is per variant URL;
  after an ABR switch mid-break, two variants may number the same time differently.
- **Empty after stripping**: the newest known segments are listed again with their numbers
  (`resequence`, so the player gets nothing new and nothing renumbered); 1.x's replay of the
  last clean playlist is gone.
- **Ad segment answers**: ad segments never appear in served playlists. A leftover request for
  a remembered ad URL is answered locally with one MPEG-TS null packet (or an MP4 `ftyp`),
  i.e. no media. Chosen over an empty 204 (cannot be tested against Twitch's player here) and
  over a generated silent/black segment (it would have to match the stream's codecs and
  timestamps; a mismatch is a decode error, worse than a hole).
- **Off switch while a tab is open**: the worker and fetch hooks see `enabled: false` and become
  passive at once; the scripts disappear on the next reload.

## Deviations from the research technique (and why)

| Research (vaft) | Here | Why |
|---|---|---|
| `eval(workerString)` of the original worker | concatenation after our prelude, `"use strict"` hoisted | no `eval` needed; same top-level semantics |
| HEVC variants swapped to AVC URLs with padded URL lines, reload onto a modified master | HEVC/AV1 variants removed when AVC exists (option, default on) | much simpler, no extra reloads; costs 1440p/4K enhanced quality while on |
| rewrite every `PlaybackAccessToken` to `popout` | only live `site` requests | leaves embeds/VODs/mini player alone |
| SERVER-TIME re-injection into cached masters | not needed | backup masters are never served to the player, only their media playlists |
| fetch one ad segment during prerolls "to start faster", ad-beacon spoofing | not done | research marks spoofing counter-productive; the prefetch trick is an ad impression |
| visibility spoofing | not done | broke other extensions (research §5) |
