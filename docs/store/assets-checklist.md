# Images and listing assets

Sizes per [Chrome: supplying images](https://developer.chrome.com/docs/webstore/images). Check the dashboard on the day: it
shows what it marks as required.

| Asset | Spec | Status | Notes |
|---|---|---|---|
| Store icon | 128x128 PNG (art about 96x96 with transparent padding) | **Have** `icons/icon128.png` (128x128 RGBA) | Dashboard asks for the icon upload too; use the same file. Look at it once on white and dark backgrounds. |
| Screenshots | 1-5, **1280x800** (or 640x400), PNG/JPEG, square corners, no transparency | **Missing: to take** | At least one is mandatory. Plan below. |
| Small promo tile | **440x280** PNG/JPEG | **Missing** | Marked required by some docs, optional by others: make it. Not localisable. |
| Marquee promo tile | 1400x560 | Optional, skip | Only for featured carousel. |
| Promo video | YouTube URL | Optional, skip | Do not upload a video demonstrating YouTube ad removal (invites attention). |

Edge Add-ons: logo 128x128+ (use `icon128.png`), screenshots 1280x800 or 640x480, small
promo tile 440x280 optional-but-advisable. Opera: icon 64x64 and 128x128 on its own, screenshots
(see `edge-opera.md`). Make 64x64 from `icon128.png` if Opera asks.

## Screenshot plan (real captures only; no mock-ups)
Take with the real extension loaded, 1280x800 browser viewport, on a clean profile. Use
`mcp__Claude_Browser` or a normal Chrome window resized to 1280x800 and save as PNG. Do not
include your bookmarks, other extensions, personal tabs or account names. Do not show logos of
YouTube/Twitch; if a page is shown, use a neutral news/test page.

1. **Popup on a busy page**: the popup open on a news site: master switch, per-site switch, counts
   (ads, trackers, cookies, banners). Caption: "See what was blocked on this page."
2. **Settings page, top**: the feature switches (Ads, Trackers, Cookie banners, tracking
   parameters, filter-list updates). Caption: "Everything is optional and local."
3. **Settings page, Support section + licence**: the "Tip via Revolut" button (shows it is free
   and optional). Take it with only the Revolut part in view if you prefer to keep crypto
   addresses off the store page (see `review-risks.md` risk 6).
4. **Element picker**: a page with the picker highlighting an element, plus "My filters".
   Caption: "Hide any element, per site."
5. *(Optional)* **Before/after** of the same page with and without Ad Shield (two real captures
   side by side, composed by you). Keep it honest: a real page, no edited ads.

Do NOT make screenshots of YouTube or Twitch with the logos prominent; avoid anything suggesting
endorsement.

## Small promo tile (440x280)
Simple: the shield icon, the text "Ad Shield" and one line "Free. Open source. No telemetry."
Flat colour, no brand logos, no "blocks 100%". Make it in any design tool; export PNG.

## Other
- Zip: `python3 -I tools/package.py` (excludes `_metadata`, tests, docs). Chrome rejects a zip
  with an `_metadata` folder, and `tools/package.py` already skips it; verify with `unzip -l`.
- Manifest `description` is 117 characters (limit 132); keep it that way.
