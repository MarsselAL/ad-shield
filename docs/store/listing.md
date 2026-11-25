# Chrome Web Store listing text

Copy each block into the dashboard's **Store listing** tab. Same text works for Edge and Opera
(see `edge-opera.md`).

## Name
`Ad Shield`  (max 75 chars; no keywords, no "YouTube"/"Twitch" in the name; see `review-risks.md`)

## Summary / short description (max 132 characters)
```
Free, open-source ad, tracker and cookie-banner blocker with Twitch video-ad support. No telemetry, no remote config.
```
(117 characters; identical to the manifest `description`, which is the Web Store summary.)

## Detailed description (plain text; paste as is)
```
Ad Shield is a free, open-source ad blocker for Chrome (and other Chromium browsers).

WHAT IT DOES
• Blocks ad and tracker requests using public, community-maintained filter lists (Chrome's declarativeNetRequest, so Ad Shield never reads the pages you visit to block them).
• Hides ad boxes and cookie-notice banners with element-hiding CSS.
• Removes cookies from third-party requests to about 3,800 known tracker domains.
• Optionally clicks "reject" on cookie pop-ups (off by default; uses an open-source consent library).
• Strips known tracking parameters (utm_*, fbclid, gclid and about 40 others) from links you open.
• Video sites: removes ad data from the player and feed on supported video sites, and on supported live-streaming sites plays an ad-free copy of the stream when one is available. These sites change often, so it can stop working until an update. Some ads cannot be removed.
• Pick an element on any page and hide it for good ("Hide an element"); your own filters are editable in Settings.
• Per-site switch in the popup: turn Ad Shield off for a site that breaks.
• Filter lists update about once a week (can be turned off).

PRIVACY
• No telemetry, no analytics, no accounts, no remote configuration. Nothing you browse is sent to the developer.
• Settings, your site list and your own filters stay in your browser.
• The only network requests Ad Shield makes itself: the weekly download of three public filter lists from their official hosts, and, on a supported live-streaming site, requests to that site's own servers for an ad-free copy of the stream you are watching.
• Free and open source under the MIT licence. Third-party components and their licences are listed in the source repository (NOTICE.md).

PERMISSIONS
Ad Shield asks for access to all websites because blocking, hiding and cookie rules must apply on every site you visit. It does not collect or transmit what it sees. Full explanation and source code are linked below.

LIMITS
Not every ad can be blocked (Chrome's rule system cannot express every filter type). Do not run several ad blockers at once. Ad Shield is independent and not affiliated with any website or filter-list project.

SUPPORT
Ad Shield is free. If it saves you time, an optional tip is welcome: https://revolut.me/marsel951u

SOURCE CODE AND ISSUES
https://github.com/MarsselAL/ad-shield
```
Notes: v1 was rejected for keyword spam (Yellow Argon, 22 Nov 2026) over the line listing
"YouTube, Google, Twitch, Amazon, EasyList or DuckDuckGo". The text above names no third-party
brands at all; keep it that way (attribution lives in NOTICE.md, not the listing).
"No telemetry / no remote config" are true (see `privacy-policy.md`). The repo is private
today; the GitHub link must go live (repo public) before submission or be removed.
The Revolut link is the only donation link in the listing, as requested. The popup and settings
page also show USDC and BTC addresses (see `review-risks.md`, risk 6).

## Category
**Productivity** (Chrome has no "Ad blocker" category; ad blockers sit under Productivity or, in
the newer list, "Tools"). Pick whichever of the two the dashboard offers; "Productivity" is the
safest.

## Language
English (single language). Set the manifest `default_locale` only if you add `_locales/`; not needed.

## Other dashboard fields
| Field | Value |
|---|---|
| Official URL | none (or the GitHub repo once public) |
| Homepage URL | https://github.com/MarsselAL/ad-shield (once public); or the Pages site https://marsselal.github.io/ad-shield/ |
| Support URL | https://github.com/MarsselAL/ad-shield/issues (enable Issues first) |
| Privacy policy URL | https://marsselal.github.io/ad-shield/store/privacy-policy.html (live once the repo is public and Pages is on: `SUBMIT-NOW.md` step G) |
| Mature content | No |
| Pricing | Free; no in-app purchases |
| Visibility | Public (suggest starting with **Unlisted** for a first review, then switching to Public) |
| Regions | All |
| Test instructions (optional but advisable) | "No account needed. Install, open any news site and the popup shows blocked counts. YouTube/Twitch features need no login. Settings page: right-click icon > Options." |
