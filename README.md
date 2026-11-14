# Ad Shield

A Manifest V3 browser extension (Chrome 120+, also Edge and Brave) that blocks ads, trackers,
tracking cookies and cookie banners on all sites, and video ads on Twitch live streams. Plain
JavaScript, no runtime dependencies, no proxies, no telemetry, no remote configuration.

## What it does

**On all sites** (built from EasyList, EasyPrivacy and the EasyList Cookie List):

- **Ads**: blocks ad requests (static declarativeNetRequest rules) and hides ad elements
  (element-hiding CSS).
- **Trackers**: blocks tracking and analytics requests.
- **Tracking cookies**: removes the `Cookie` request header and the `Set-Cookie` response header
  on third-party requests to about 3,800 known tracker domains (taken from EasyPrivacy).
- **Cookie banners: hide**: blocks consent-banner scripts and hides cookie notices.
- **Cookie banners: auto-reject** (off by default): DuckDuckGo's autoconsent clicks "reject" /
  "only necessary" on known consent pop-ups.
- **Per-site switch**: the popup turns everything off for the current site (allowlist).
- **Weekly filter-list updates** (on by default, can be switched off): downloads the three lists
  from their public addresses once a week, converts them in the browser and installs them as
  dynamic rules; "Update now" and "Use built-in lists" on the options page. The generic
  element-hiding CSS stays as built into the extension.

**On Twitch** (unchanged): when a stream playlist contains an ad, the extension asks Twitch for
the same stream with a different player type (a "backup stream") and plays that copy if it has
no ad. If every backup also has the ad, it removes the ad segments from the playlist. It also
blocks Twitch's client-side ad requests and hides standalone ad videos.

Test status: see [docs/TESTING.md](docs/TESTING.md). Short version: offline tests and a
browser smoke test pass (the smoke test checks the general rules with Chrome's own matcher and
the cosmetic CSS on a local page); a live Twitch run showed normal playback, but no ad appeared
in the automated run, so Twitch ad blocking was not yet proven there.

## Install from this folder

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Reload tabs that were already open.

## Install on another PC (Windows or Linux; also Edge or Brave)

1. On this computer run `python3 tools/package.py`. It makes `dist/ad-shield-<version>.zip`.
2. Copy the zip to the other PC (USB stick, cloud drive, or email it to yourself).
3. Unzip it. You get a folder `ad-shield` that contains `manifest.json`.
4. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), turn on
   **Developer mode**, click **Load unpacked**, and pick the `ad-shield` folder.
5. **Keep the folder.** The browser reads the extension from it; if you delete or move it,
   the extension stops working.

To update: replace the folder contents with the new version, then click the reload icon on the
extension's card in `chrome://extensions`.

## How it works

General blocking (details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- `tools/build_rules.py` downloads the three lists with `curl` into a fresh temporary folder and
  converts them with our own converter (`tools/filterlist.py`) into static DNR rulesets in
  `rules/` (`ads_1`, `privacy_1`, `cookies_1`, `cookie_strip`) and cosmetic data in
  `rules/cosmetic/`. It also turns our own hand-written host list `rules/curated_hosts.txt` into
  `ads_curated` and `privacy_curated` (`--curated-only` rebuilds just those, offline). The output is committed, so the extension works offline.
- Weekly updates: the background downloads the same three lists, converts them with a
  JavaScript port of the converter (`src/shared/filterlist.js`, checked against the Python output
  by a golden-file test) and installs them as dynamic rules in place of `ads_N` / `privacy_N` /
  `cookies_N` (all three or none; sanity checks on versions and rule counts). The site-specific
  hiding data is replaced too; the generic hiding CSS is not.
- Generic element hiding is a CSS file registered as a content script: no JavaScript runs for it.
  Site-specific hiding: a tiny page script (top frame only) says hello, and the background
  injects that site's CSS with `chrome.scripting.insertCSS`. No MutationObserver, no polling.
- Auto-reject: the unmodified autoconsent content script (`vendor/autoconsent/`) runs in all
  frames while the option is on; the background answers its messages (rules, page-world
  snippets) as its documentation describes.
- Allowlisted sites get one dynamic `allowAllRequests` rule and are excluded from all content
  scripts.

Twitch:

- A script in the page (MAIN world) wraps `fetch` and Twitch's video Web Worker.
- Inside the worker, each media playlist is checked for ad markers. If one is found, the
  worker fetches the same stream as other player types, and serves the first one without ads.
  If none is clean, it strips the ad segments.
- If anything goes wrong, the original response is passed through unchanged.
- A small bridge script (ISOLATED world) passes settings and events; the background service
  worker keeps settings, statistics and the network block lists.
- The Twitch content scripts are declared in `manifest.json` (`build/main-world.js`,
  `build/isolated-world.js`). They are not loaded on `clips.twitch.tv`.

## Converted filters (lists of 2026-11-13)

| Ruleset | Rules | Of which allow | Source |
|---|---|---|---|
| `ads_1` | 3,781 | 516 | EasyList |
| `ads_curated` | 1 (44 hosts) | 0 | `rules/curated_hosts.txt` (ours) |
| `privacy_1` | 9,239 | 842 | EasyPrivacy |
| `privacy_curated` | 1 (45 hosts) | 0 | `rules/curated_hosts.txt` (ours) |
| `cookies_1` | 1,794 | 427 | EasyList Cookie List |
| `cookie_strip` | 4 (3,791 domains) | 0 | EasyPrivacy `\|\|domain^$third-party` |
| `client_ads`, `trackers` | 2 + 2 | 0 | Twitch rules (ours) |

Total 14,824 static rules, below Chrome's guaranteed 30,000, so no shared global pool is needed.
Plain `||domain^` filters with the same options are merged into one rule with `requestDomains`
(1,000 domains per rule), which is why the counts are small. Cosmetic: 13,635 generic and 16,492
site-specific EasyList selectors, 15,272 generic and 18,736 site-specific cookie-list selectors.

Skipped (counted in `rules/build-info.json`): EasyList 4,156 of 77,788 filters (mostly 2,969
`$popup` and 572 `$document` page blocks DNR cannot express, 295 procedural/scriptlet, 240
wildcard-TLD domains); EasyPrivacy 75 of 56,631 (mostly `$redirect`); cookie list 79 of
25,382. Not converted at all: procedural cosmetic filters (`#?#`, `:has-text()`), scriptlets
(`##+js`, `#$#`), `$redirect`, `$csp`, `$removeparam`, `$rewrite`, `$popup`, complex regex.

To rebuild with fresh lists: `python3 -I tools/build_rules.py`, then `bash tests/run.sh`.

## Permissions and why

| Permission | Why |
|---|---|
| `storage` | Settings, allowlist and statistics. |
| `scripting` | Registers the cosmetic CSS / page script / autoconsent content scripts; injects site CSS; runs autoconsent's page-world snippets; removes leftover dynamic scripts of older versions. |
| `declarativeNetRequest` | Static rulesets in `rules/` and the dynamic allowlist rule. |
| `declarativeNetRequestFeedback` | Popup counts via `getMatchedRules` and the badge count (see below). |
| host `<all_urls>` | Needed for `modifyHeaders` (cookie stripping), for CSS on all sites and for autoconsent. |
| host `*://*.twitch.tv/*` | Twitch scripts (kept explicitly; covered by `<all_urls>`). |

There is no `tabs`, `webRequest`, `webNavigation`, `cookies` or `proxy` permission.

### Why `getMatchedRules` for the counts

The extension is installed unpacked, so both feedback APIs would work. `onRuleMatchedDebug`
fires for every matched request and keeps the service worker awake (and is unpacked-only),
which costs performance on every page. Instead the popup calls
`chrome.declarativeNetRequest.getMatchedRules({tabId, minTimeStamp})` once when it opens
(rate limit: 20 calls per 10 minutes) and sorts the matches by ruleset into ads, trackers,
cookies stripped and cookie-banner scripts blocked; allow rules are left out by their id range.
"Cookie banners handled" also adds banners the page script saw hidden and pop-ups autoconsent
rejected. The toolbar badge uses
`setExtensionActionOptions({displayActionCountAsBadgeText: true})` (Chrome counts blocked
requests itself); on Twitch tabs the Twitch count replaces it once a video ad was handled.

## Privacy

- No proxies, no telemetry, no analytics, no remote configuration.
- The only network requests the extension makes are plain downloads of the three filter lists
  (`https://easylist.to/easylist/easylist.txt`, `https://easylist.to/easylist/easyprivacy.txt`,
  `https://secure.fanboy.co.nz/fanboy-cookiemonster.txt`), once a week while "Update filter
  lists automatically" is on, or when you press "Update now". No cookies or other data are
  sent with them. Switch the option off to make no requests at all.
- autoconsent is downloaded only when you run `tools/vendor_autoconsent.py`, never by the
  extension.
- Settings and statistics stay in your browser (`chrome.storage`).

## Settings and on/off switch

The popup has the master switch, the per-site switch, counts for the current page and, on
Twitch tabs, the Twitch status and counts. The options page has these settings:

| Setting | Default | Effect |
|---|---|---|
| Enabled | on | Master switch for everything (all-sites features and Twitch). |
| Debug logging | off | `[TAS]` debug lines in the page and extension consoles (warnings/errors always). |
| Ads | on | Rulesets `ads_*` + EasyList element hiding. |
| Trackers | on | Rulesets `privacy_*`. |
| Strip tracking cookies | on | Ruleset `cookie_strip`. Requests that another rule blocks are blocked anyway; an exception (allow) rule also stops the stripping. |
| Cookie banners: hide | on | Rulesets `cookies_*` + cookie-list element hiding. |
| Cookie banners: auto-reject | off | Registers autoconsent (a ~160 KB script in every page and frame). |
| Update filter lists automatically | on | Weekly download and conversion of the three lists (dynamic rules; the generic hiding CSS stays from the package). The options page shows each list's version, date, rule count and status, with "Update now" and "Use built-in lists". |
| Sites where blocking is off | empty | One site per line, covers subdomains. Also turns the Twitch features off on twitch.tv. |
| Block client-side ad requests | on | DNR ruleset `client_ads`: `edge.ads.twitch.tv` and Amazon's `apstag.js`, only for requests from twitch.tv pages. |
| Block ad tracking paths | off | DNR ruleset `trackers`: `twitch.tv/r/s/` (scripts) and `/r/c/` (images). Untested on live Twitch. |
| Hide standalone video ads | on | Hides, mutes and pauses ad `<video>` elements whose source is an Amazon ad host. |
| Prefer AVC (H.264) streams | on | Removes HEVC/AV1 variants when H.264 exists (avoids player errors when switching during ads; turns off 1440p/4K "enhanced" quality). |
| Backup stream order | site, popout, mobile_web, embed, autoplay | Validated: known types only, no duplicates, `autoplay` (360p) last. |
| Show a notice when an ad is blocked | on | Small "Ad blocked – using backup stream" note in the player. |
| Reset statistics | | Clears Twitch tab and lifetime counts. |

**Off (master or per site):** network rules stop at once; CSS already in a page stays until it
is reloaded. On Twitch the page script stops rewriting tokens and no longer wraps new workers.
Reload the tab after switching.

## Limitations

- **Lists are as fresh as the last build.** There is no automatic list update (by design: no
  remote configuration). Rebuild and reload to update.
- DNR cannot express everything uBlock Origin can: pop-up blocking, scriptlets, procedural
  cosmetic filters, `$redirect`/`$csp`/`$removeparam`, and most regex filters are skipped, so
  some sites (especially anti-adblock walls) work less well than with uBlock Origin.
- Site-specific hiding is applied a moment after the page starts (it waits for the background),
  so an ad can flash briefly. It is applied in the top frame only; generic hiding runs in all
  frames.
- "Banners handled" does not count banners hidden by the generic cookie CSS.
- Allowlisting twitch.tv also switches off the Twitch video-ad features there.
- **Twitch changes can break the Twitch part** until a new release. The usual fixes are the
  persisted query hash and the Client-ID in `src/config.js` (`gql.persistedQueryHash`,
  `gql.clientId`), or the ad marker lists.
- The Twitch backup stream may have lower quality, or the video may be briefly black or frozen
  at the start or end of an ad break. Ads may still appear when no ad-free backup is available.
- Client-side Twitch ads (`twitch-maf-ad`) have nothing to strip; only the network block rule
  applies. VODs are only stripped; there is no backup stream for VODs.
- Not on the Chrome Web Store. `clips.twitch.tv` is excluded. No Firefox build.
- Do not run another ad blocker at the same time.

## When something changes

Twitch: everything Twitch can change lives in `src/config.js`, each value with a note on its
source. After editing anything in `src/`:

```
python3 tools/build.py                 # rebuild build/*.js
python3 tools/build.py --check         # only check the bundles are up to date
python3 -I tools/build_rules.py        # re-download and convert the filter lists
python3 -I tools/vendor_autoconsent.py # re-vendor autoconsent (pinned version, hash checked)
bash tests/run.sh                      # all tests (rebuilds the bundles first)
```

Then bump `version` in `manifest.json` and `src/config.js`, and reload the extension.

## Troubleshooting

- **A site breaks**: turn blocking off for it with the popup's site switch and reload.
- **A cookie banner stays**: turn on *Cookie banners: auto-reject*.
- **Twitch ads still play**: enable *Debug logging*, reload the tab, look for `[TAS]` lines in
  the page console.
- **Black screen after a Twitch ad**: the extension reloads the player once. If the popup says
  "Degraded", reload the tab, or put `popout` first in the backup order.
- **Video errors on 1440p/4K**: keep *Prefer AVC* on.
- **Nothing happens**: check `chrome://extensions` for errors and disable other ad blockers.

## Tests

- `bash tests/run.sh` – offline: JavaScriptCore unit tests, `tests/test_rules.py` (converter,
  and every generated DNR rule checked against `tests/dnr_schema.py`) and the manifest check.
- `python3 tools/live_test.py --smoke` – starts Chrome with a temporary profile and checks the
  extension loads, the rulesets match test requests (`testMatchOutcome`, nothing is sent) and
  the cosmetic CSS works on a page served from 127.0.0.1. No Twitch traffic.
- `python3 tools/live_test.py --live CHANNEL [--minutes N] [--vod URL] [--switch-to CH2]
  [--compare-without-extension]` – **makes real requests to Twitch.**

See [docs/TESTING.md](docs/TESTING.md) for results.

## Licence and credits

Code: MIT, see [LICENSE](LICENSE). Filter data: The EasyList authors (https://easylist.to/),
used under CC BY-SA 3.0 (cookie list header: CC BY 3.0); autoconsent: DuckDuckGo, MPL-2.0,
unmodified. Details in [NOTICE.md](NOTICE.md) and [rules/NOTICE.md](rules/NOTICE.md).
Not affiliated with or endorsed by Twitch, Amazon, EasyList or DuckDuckGo.
