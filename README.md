# Twitch Ad Shield

A Manifest V3 browser extension (Chrome 120+, also Edge and Brave) that blocks video ads on
Twitch live streams. Plain JavaScript, no dependencies, no proxies, no telemetry, no remote
configuration.

## What it does

When a stream playlist contains an ad, the extension asks Twitch for the same stream with a
different player type (a "backup stream") and plays that copy if it has no ad. If every backup
also has the ad, it removes the ad segments from the playlist. It also blocks Twitch's
client-side ad requests and hides standalone ad videos.

Test status: see [docs/TESTING.md](docs/TESTING.md). Short version: offline tests and a
browser smoke test pass; a live run showed normal playback, but no ad appeared in the
automated run, so ad blocking was not yet proven there.

## Install from this folder

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Reload any Twitch tabs that were already open.

## Install on another PC (Windows or Linux; also Edge or Brave)

1. On this computer run `python3 tools/package.py`. It makes `dist/twitch-ad-shield-<version>.zip`.
2. Copy the zip to the other PC (USB stick, cloud drive, or email it to yourself).
3. Unzip it. You get a folder `twitch-ad-shield` that contains `manifest.json`.
4. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), turn on
   **Developer mode**, click **Load unpacked**, and pick the `twitch-ad-shield` folder.
5. **Keep the folder.** The browser reads the extension from it; if you delete or move it,
   the extension stops working.

To update: replace the folder contents with the new version, then click the reload icon on the
extension's card in `chrome://extensions`.

## How it works

- A script in the page (MAIN world) wraps `fetch` and Twitch's video Web Worker.
- Inside the worker, each media playlist is checked for ad markers. If one is found, the
  worker fetches the same stream as other player types, and serves the first one without ads.
  If none is clean, it strips the ad segments.
- If anything goes wrong, the original response is passed through unchanged.
- A small bridge script (ISOLATED world) passes settings and events; the background service
  worker keeps settings, statistics and the network block lists.
- The content scripts are declared in `manifest.json` (`build/main-world.js`,
  `build/isolated-world.js`). They are not loaded on `clips.twitch.tv`.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Permissions and why

| Permission | Why |
|---|---|
| `storage` | Settings and statistics. |
| `scripting` | Used only to remove leftover dynamic scripts registered by older versions. |
| `declarativeNetRequest` | Static block lists in `rules/`: `edge.ads.twitch.tv` and Amazon's `apstag.js` (on by default), ad tracking paths (off by default). |
| host `*://*.twitch.tv/*` | Needed to run the scripts on Twitch pages. |

There is no `tabs`, `webRequest`, `proxy` or `<all_urls>` permission.

## Privacy

- No proxies. Your video requests go from your browser straight to Twitch, as normal.
- No telemetry, no analytics, no remote configuration.
- The background service worker makes no network requests.
- Settings and statistics stay in your browser (`chrome.storage`).

## Settings and on/off switch

The popup has the on/off switch, status for the current tab and counts. The options page has
these settings:

| Setting | Default | Effect |
|---|---|---|
| Enabled | on | Master switch (scripts and network rules). |
| Block client-side ad requests | on | DNR ruleset `client_ads`: `edge.ads.twitch.tv` and Amazon's `apstag.js`, only for requests from twitch.tv pages. |
| Block ad tracking paths | off | DNR ruleset `trackers`: `twitch.tv/r/s/` (scripts) and `/r/c/` (images). Untested on live Twitch. |
| Hide standalone video ads | on | Hides, mutes and pauses ad `<video>` elements whose source is an Amazon ad host. |
| Prefer AVC (H.264) streams | on | Removes HEVC/AV1 variants when H.264 exists (avoids player errors when switching during ads; turns off 1440p/4K "enhanced" quality). |
| Backup stream order | site, popout, mobile_web, embed, autoplay | Validated: known types only, no duplicates, `autoplay` (360p) last. |
| Show a notice when an ad is blocked | on | Small "Ad blocked – using backup stream" note in the player. |
| Debug logging | off | `[TAS]` debug lines in the page and extension consoles (warnings/errors always). |
| Reset statistics | | Clears tab and lifetime counts. |

**Off:** the page script stops rewriting tokens and no longer wraps new workers, so everything
passes through unchanged. A worker that was created before the settings loaded is still
wrapped, but it passes every request through. Reload the tab after switching.

## Limitations

- **Twitch changes can break it** until a new release. The usual fixes are the persisted query
  hash and the Client-ID in `src/config.js` (`gql.persistedQueryHash`, `gql.clientId`), or the
  ad marker lists.
- The backup stream may have lower quality, or the video may be briefly black or frozen at the
  start or end of an ad break.
- Ads may still appear when no ad-free backup is available.
- Client-side ads (`twitch-maf-ad`) have nothing to strip; only the network block rule
  applies. Its effect on the player is not verified.
- VODs are only stripped; there is no backup stream for VODs.
- Not on the Chrome Web Store. `clips.twitch.tv` is excluded. No Firefox build.
- Do not run another Twitch ad blocker at the same time.

## When Twitch changes something

Everything Twitch can change lives in `src/config.js`, each value with a note on its source.
After editing anything in `src/`:

```
python3 tools/build.py          # rebuild build/*.js
python3 tools/build.py --check  # only check the bundles are up to date
bash tests/run.sh               # all tests (rebuilds first)
```

Then bump `version` in `manifest.json` and `src/config.js`, and reload the extension.

## Troubleshooting

- **Ads still play**: enable *Debug logging*, reload the tab, look for `[TAS]` lines in the
  page console.
- **Black screen after an ad**: the extension reloads the player once. If the popup says
  "Degraded", reload the tab, or put `popout` first in the backup order.
- **Video errors on 1440p/4K**: keep *Prefer AVC* on.
- **Nothing happens**: check `chrome://extensions` for errors and disable other Twitch ad blockers.

## Tests

- `bash tests/run.sh` – offline unit tests (macOS JavaScriptCore) and manifest check.
- `python3 tools/live_test.py --smoke` – starts Chrome with a temporary profile and checks the
  extension loads. No Twitch traffic.
- `python3 tools/live_test.py --live CHANNEL [--minutes N] [--vod URL] [--switch-to CH2]
  [--compare-without-extension]` – **makes real requests to Twitch.**

See [docs/TESTING.md](docs/TESTING.md) for results.

## Licence

MIT, see [LICENSE](LICENSE). Not affiliated with or endorsed by Twitch or Amazon.
