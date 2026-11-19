# Ad Shield on iPhone (free, Safari + Userscripts)

Ad Shield's YouTube and Twitch video-ad code also ships as one userscript, `ad-shield.user.js`.
It runs in Safari on iPhone and iPad through **Userscripts**, a free, open-source Safari extension
(quoid/userscripts on the App Store). No paid Apple Developer account and no sideloading are needed.

## Install (for friends)

1. Install **Userscripts** from the App Store (free, iOS 15.1 or later).
2. Turn it on. Open **Settings → Apps → Safari → Extensions → Userscripts** (on older iOS:
   **Settings → Safari → Extensions**). Switch it on, then set **All Websites** to **Allow**.
   At minimum, allow youtube.com and twitch.tv.
3. Add the script, using either of these:
   - **Files**: save `ad-shield.user.js` (from AirDrop, Messages, iCloud Drive and so on) into the
     **Userscripts** folder in the Files app. Open the Userscripts app once to see or change
     which folder it uses.
   - **Safari**: open a link to the `.user.js` file, tap the puzzle-piece (extensions) button,
     choose Userscripts, then choose to install the script.
4. Reload YouTube or Twitch in Safari. In Safari's extensions menu, Userscripts should show
   "Ad Shield (YouTube + Twitch)" as active on the page.

To update, replace the file with a newer one. To turn it off, switch the script off in the
Userscripts popup.

## What it does on iOS

| Site | Status |
|---|---|
| YouTube (m.youtube.com, www.youtube.com in Safari) | Ad data is removed from the player response before the player reads it (the same rules as the Chrome extension, `rules/scriptlets.json`). The 17-second "fake buffering" wait is cut short, and ad slots are hidden with `rules/cosmetic/youtube.css`. |
| Twitch (m.twitch.tv, www.twitch.tv) | The same worker and playlist code as the extension: during an ad it switches to an ad-free backup stream. **This only works if Safari on iPhone plays Twitch through Twitch's JavaScript worker (Media Source).** If Twitch hands the stream to Safari's built-in HLS player instead, no script can see the playlist, and Twitch ads still play. This has not yet been tested on a real iPhone (see "Status of testing"). |

## What it doesn't do on iOS

- No popup, no options page, no counters and no "ad blocked" toasts. The script always runs with
  the default settings.
- No network blocking (DNR) and no general cosmetic filtering of other sites. Only YouTube and
  Twitch are covered. For general ad blocking in Safari, use a free content blocker app as well.
- No YouTube app or Twitch app support: apps are not Safari, so nothing can be injected into them.
- If a site's Content Security Policy blocks page-injected scripts, the Userscripts app cannot
  inject the script into the page world, and the script does nothing there. Safari offers no way
  around this.

## Why not Chrome on iPhone?

On iOS, every browser, Chrome included, is a skin over Apple's WebKit, and Apple lets only Safari
load web extensions. Chrome for iOS has no extensions and no userscripts, so Ad Shield can't run
there. Safari with the Userscripts extension is the free route.

## How the file is built

`python3 -I tools/build.py` writes `dist/ad-shield.user.js` next to the extension bundles. It holds:

- The YouTube scriptlets: `src/scriptlets/lib.js` and `src/scriptlets/runner.js`, plus
  `rules/scriptlets.json`.
- `rules/cosmetic/youtube.css`, added as a `<style>` element.
- The Twitch MAIN-world code, the same files as `build/main-world.js`.

The header asks for `@run-at document-start` and `@inject-into page`, because the hooks have to
patch `JSON.parse`, `fetch` and `Worker` in the page's own world before the site's scripts run.
There is no `chrome.*` API in a userscript, so the ISOLATED-world bridge, settings storage, stats
and DNR are left out. `dist/` is not committed: build the file, then share it.
`tests/userscript.test.js` checks the header and that the file parses and hooks the right things
in a simulated page.

## Status of testing

- Done: the jsc tests (`bash tests/run.sh`) check the header and that the script parses. They also
  check, on stubbed YouTube and Twitch pages, that the right hooks install.
- Not done yet: a run in Safari on iOS. The iOS Simulator needs the full Xcode, which this Mac does
  not have. Two open questions decide what works on a real iPhone:
  1. Does Userscripts' `document-start` + `page` injection run before YouTube's and Twitch's own
     scripts, without being blocked by their CSP?
  2. Does Twitch in iOS Safari play through its worker (Media Source, interceptable) or through
     native HLS (not interceptable)?

  A quick check: install the script, open a Twitch stream, and connect the iPhone to a Mac with
  Safari's **Develop** menu (Web Inspector). In the console, `window.__tas_page_installed__`
  should be `true`. Look in the Network tab for `usher.ttvnw.net` playlist requests made from a
  **worker** (Twitch's MSE path) rather than by the `<video>` element (native HLS).

## Optional tip link

To show a "Like Ad Shield? An optional tip: …" line in the builds you share, put one public
https link in `docs/donate.txt`, for example a revolut.me link, and rebuild. The line appears in
the userscript header and in `INSTALL.txt` inside the Chrome zip. An empty file means no tip line.
The build accepts only a single https link, so bank account numbers can never end up in a shared
file.
