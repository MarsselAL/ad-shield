# Images and listing assets

Sizes per [Chrome: supplying images](https://developer.chrome.com/docs/webstore/images). Check the dashboard on the day: it
shows what it marks as required.

## Files ready (docs/store/images/, made 21 Nov 2026)

**Icon (AdBrake 2.0.3):** done. The new AdBrake icon (light app tile, red shield, black/red "A")
is in `icons/source/adbrake-icon-master.png` (full size, transparent corners; not shipped in the
zip). `python3 -I tools/make_icons.py` rebuilds every icon from it: `icons/icon16.png` and
`icon32.png` are the shield alone, cropped tight for the toolbar; `icon48.png`, `icon128.png` and
`src/icon128.png` are the whole tile; `store-icon-64/128/300.png` are the tile with Chrome's 1/8
padding per side.

**To do (AdBrake 2.0.3 rebrand):** the screenshots and promo tiles below may still show the old
name, icon and colours. Re-run `python3 -I tools/store_shots.py` (needs Chrome and a network page
load) before submitting 2.0.3.

All screenshots are compositions of **real captures** of the extension at 2.0.0 (popup and settings
page), taken by `python3 -I tools/store_shots.py` in headless Chrome with the unpacked extension.
The popup numbers are what it really counted on a news front page (edition.cnn.com) that run.
In the store variant of the settings page the rows that name YouTube/Twitch and the USDC/BTC
addresses are hidden (`review-risks.md` risk 6), and "My filters" holds three example rules saved
through the page's own Save button. No other edits. Re-run the tool to refresh them;
`docs/store/images/src/make_pages.py` holds the headlines and layout, `raw/` the captures.

| Store slot | File | Size |
|---|---|---|
| Chrome: Store icon | `store-icon-128.png` (the `icons/icon128.png` tile with 16 px padding) | 128x128 |
| Chrome: Screenshot 1 | `shot-1-popup.png` "Blocks ads, trackers and cookie banners" | 1280x800 |
| Chrome: Screenshot 2 | `shot-2-settings.png` "Every feature is a switch" | 1280x800 |
| Chrome: Screenshot 3 | `shot-3-filters.png` "Hide anything, per site" | 1280x800 |
| Chrome: Screenshot 4 | `shot-4-privacy.png` "No telemetry. Open source." | 1280x800 |
| Chrome: Screenshot 5 | `shot-5-support.png` "Free for everyone" | 1280x800 |
| Chrome: Small promo tile | `promo-small.png` | 440x280 |
| Chrome: Marquee promo tile | `promo-marquee.png` | 1400x560 |
| Edge: Extension logo | `store-icon-300.png` (same artwork, `tools/make_icons.py` at 300 px) | 300x300 |
| Edge: Screenshots (up to 10) | `shot-1` … `shot-5` | 1280x800 |
| Edge: Small promotional tile | `promo-small.png` | 440x280 |
| Edge: Large promotional tile (optional) | `promo-marquee.png` | 1400x560 |
| Opera: Icon 64x64 | `store-icon-64.png` | 64x64 |
| Opera: Icon 128x128 | `store-icon-128.png` | 128x128 |
| Opera: Screenshots | `shot-1` … `shot-5` | 1280x800 |
| GitHub README / Pages | `shot-1-popup.png` (+ the others in a grid) | 1280x800 |

All PNG, no transparency in screenshots and tiles (checked: `hasAlpha: no`), square corners.
No YouTube or Twitch logos or names appear in any image. Icons checked at 16, 32, 48 and 128 px on
white and dark: clean edges, the "A" readable down to 16 px.

## Other
- Zip: `python3 -I tools/package.py` (excludes `_metadata`, tests, docs). Chrome rejects a zip
  with an `_metadata` folder, and `tools/package.py` already skips it; verify with `unzip -l`.
- Manifest `description` is 117 characters (limit 132); keep it that way.
