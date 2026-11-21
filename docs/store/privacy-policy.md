# Ad Shield — Privacy Policy

_Last updated: 21 November 2026. Applies to Ad Shield version 2.0.0 and later._

**Short version: Ad Shield does not collect, store on any server, sell or share any personal
data. It has no developer-operated server.**

## What Ad Shield does not do
- No analytics, telemetry, crash reporting, advertising IDs or accounts.
- No data about the pages you visit, your searches, your browsing history, cookies or content is
  sent to the developer or any third party.
- No remote configuration: the extension's behaviour and its code come only from the installed
  package. No code is downloaded or executed from the network.

## What is stored on your device
Using `chrome.storage` (local to your browser profile), Ad Shield keeps: your settings, the list
of sites where blocking is off, your own element-hiding filters ("My filters"), simple counters
(how many ads/trackers were blocked), and the downloaded filter lists with their version
information. This data never leaves your browser through Ad Shield. Removing the extension
deletes it.

## Network requests the extension makes itself
1. **Weekly filter-list update** (on by default; switch it off in Settings, or press "Update now"
   to run it manually). It downloads three public text files with a plain HTTPS GET, with
   cookies omitted and no identifiers added:
   - `https://easylist.to/easylist/easylist.txt`
   - `https://easylist.to/easylist/easyprivacy.txt`
   - `https://secure.fanboy.co.nz/fanboy-cookiemonster.txt`

   Like any web request, the servers that host these files can see your IP address and the
   time of the request. Their operators have their own policies. The files are treated purely as
   data and converted in your browser into blocking rules.
2. **On Twitch pages only, when a stream contains an ad:** the extension, from the Twitch page,
   asks Twitch's own servers (`gql.twitch.tv`, `usher.ttvnw.net`) for the same stream as another
   player type. These are the same kind of requests Twitch's own player makes, they go only to
   Twitch, and are subject to Twitch's privacy policy.

Ad Shield makes no other network requests. The element picker, My filters, tracking-parameter
removal, cookie stripping and the per-site switch run entirely locally.

## What the permissions are used for
Ad Shield asks for access to all websites so its blocking and hiding rules can apply on every
site. It uses that access to block or modify requests and to hide page elements; it does not
read, copy or transmit page content. See the extension's description for a permission-by-
permission explanation.

## Support links
The popup and settings page contain an optional "Support" link (and payment addresses) that open
or display text only. Nothing is sent when they are shown. If you open the link, you visit a
third-party website (Revolut) governed by its own policy.

## Children
Ad Shield collects no data from anyone, including children.

## Changes
If this policy changes it will be updated here with a new date, and the change noted in the
release notes.

## Contact
Open an issue at https://github.com/MarsselAL/ad-shield/issues or write to
**[CONTACT E-MAIL — Marsel to fill in; use a mailbox you are happy to publish]**.

## Open source
Source code (MIT): https://github.com/MarsselAL/ad-shield — you can verify the statements above.

---
## Hosting (for Marsel, delete this section from the published copy)
- Publish `privacy-policy.html` via GitHub Pages (repo Settings > Pages > deploy from branch,
  folder `/docs`): URL becomes `https://marsselal.github.io/ad-shield/store/privacy-policy.html`.
  Pages on a private repo need a paid plan; make the repo public first. Re-generate the `.html`
  if you edit this `.md` (same text; the `.html` here has no hosting section).
- Fill in the contact e-mail before publishing.
- Statements verified against the code on 21 Nov 2026: only `src/background/updater.js` calls
  `fetch()` on an external URL (the three list URLs in `src/shared/lists.js`, https only,
  `credentials: 'omit'`); the Twitch requests are made by `src/page/page.js` / `src/worker/` with
  the page's own fetch; no `sendBeacon`, `WebSocket`, `EventSource`; no `eval` / `new Function`
  in `src/` or `vendor/autoconsent/`; the other `fetch()` calls read files inside the package via
  `chrome.runtime.getURL`; `XMLHttpRequest` in `src/page/page.js` reads Twitch's own worker
  script synchronously to wrap it (same-origin Twitch URL only). Re-check before each release.
