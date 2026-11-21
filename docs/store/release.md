# Release checklist

Run from the repository root. Nothing here needs store access until step 7.

## 1. Version
- Bump `version` in `manifest.json` and `version` in `src/config.js` (same number).
- Update the pinned version in `tests/validate_manifest.py` and `EXPECTED_VERSION` in
  `tools/live_test.py`.
- Chrome needs each upload to have a higher version than the last published one.

## 2. Build and test
```bash
python3 tools/build.py
python3 tools/build.py --check
bash tests/run.sh
```
All must pass. Do not release with a failing test.

## 3. Package
```bash
python3 -I tools/package.py
```
Output: `dist/ad-shield-<version>.zip`.

## 4. Inspect the zip
```bash
unzip -l dist/ad-shield-<version>.zip
```
Check that `_metadata`, `tests`, `docs`, `tools` and `.git` are **absent** (Chrome rejects a
zip with `_metadata`), and that `manifest.json` is at the top of the `ad-shield/` folder
(zip the contents, not an extra wrapper, if the dashboard asks for `manifest.json` at the root).
Confirm `manifest.json` `description` is at most 132 characters.

## 5. Smoke test the zip
Unzip to a fresh folder, load unpacked in a clean browser profile, open a news site, check the
popup counts and the options page.

## 6. Tag
`git tag v<version>` on the release commit (push only when you decide to publish).

## 7. Upload (each dashboard separately)
- Chrome Web Store: new item or "Package" tab, upload the zip, update the listing text from
  `listing.md`, permission justifications from `permissions.md`, privacy answers and policy URL.
  First time: submit as **Unlisted**; later, use **staged rollout** (start at a low percentage,
  raise it after a few days with no bad reviews or crash reports).
- Edge Add-ons and Opera add-ons: see `edge-opera.md`. Same zip.
- Do not resubmit repeatedly while in review: it restarts the queue.

## 8. After release
Watch reviews and the issue tracker for a few days. If a store pulls the item, do not reupload
unchanged; read the notice and fix the cause (`review-risks.md`).

## What updates without a store review
- The three filter lists (EasyList, EasyPrivacy, EasyList Cookie List) are downloaded by the
  extension weekly and converted to dynamic rules in the browser. This is data, not code, and
  needs no release.

## What needs a new store release
- Anything in the package: static rulesets in `rules/`, cosmetic data, scriptlets, Twitch and
  YouTube logic, UI, manifest, permissions, donate links, and the built-in fallback lists.
- Any change to permissions or host access (users must re-approve; Chrome may disable the
  extension until they do).
