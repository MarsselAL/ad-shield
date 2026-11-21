# Submit Ad Shield 2.0.0: click by click

Everything here is done by **you** (logins, pushes, publishing, accepting terms, clicking Submit).
Files are in this repo. Do the parts in this order: **A, G, C, then E and O** (the privacy
policy URL only works after part G).

Texts to paste come from `listing.md` (description etc.) and `permissions.md` (privacy answers).
Image slots: `assets-checklist.md`. All images are in `docs/store/images/`.

---

## A. On your Mac (5 minutes)

1. Open Terminal in the repo folder (the branch with these files, `claude/release-assets-fc71aa`).
2. Run the tests: `bash tests/run.sh`. The last line must be `ALL TESTS PASSED`.
3. Make the zips: `python3 -I tools/package.py`. You get two files in `dist/`:
   - `ad-shield-2.0.0-store.zip`: **upload this one to Chrome, Edge and Opera**.
   - `ad-shield-2.0.0.zip`: for the GitHub release and for sharing by hand (has INSTALL.txt).
4. Optional last check: unzip the store zip into a new folder, open `chrome://extensions`,
   Developer mode on, **Load unpacked**, pick that folder, open a news site, click the icon:
   counts appear. Then remove it again.

## G. GitHub (github.com/MarsselAL/ad-shield)

1. **Push the branch.** In Terminal: `git push -u origin claude/release-assets-fc71aa`
   (GitHub asks you to sign in; use a personal access token or GitHub Desktop if a password is refused).
2. **Merge into main.** On github.com, open the repo, click **Compare & pull request** for that
   branch, base `main`. Check the files, click **Create pull request**, then **Merge pull request**
   → **Confirm merge**.
3. **Last look before going public.** Settings › Code security: turn on **Secret scanning** if offered.
   The repo has no passwords or keys; the donation addresses are meant to be public.
4. **Make it public.** Settings › General › scroll to **Danger Zone** › **Change visibility** ›
   **Make public** › type the repo name to confirm.
5. **Turn on Issues** (support URL): Settings › General › Features › tick **Issues**.
6. **Turn on Pages.** Settings › **Pages** › Source: **Deploy from a branch** › Branch: `main`,
   folder: **/docs** › **Save**. Wait 1-3 minutes, refresh: the page shows the site address.
7. **Check the two URLs open in a private window:**
   - https://marsselal.github.io/ad-shield/ (small landing page)
   - https://marsselal.github.io/ad-shield/store/privacy-policy.html (privacy policy: **use this in every store**)
8. **Repo "About" box** (cog next to About on the repo home page): Description
   `Free, open-source ad, tracker and cookie-banner blocker for Chrome, Edge and Opera. No telemetry.`,
   Website `https://marsselal.github.io/ad-shield/`, Topics `adblock`, `privacy`,
   `chrome-extension`, `manifest-v3`, `cookie-banner`. Save.
9. **Create the release.** Repo › **Releases** › **Draft a new release** ›
   - Choose a tag: type `v2.0.0` › **Create new tag on publish**, target `main`.
   - Title: `Ad Shield 2.0.0`
   - Notes (paste):
     ```
     First public release.
     - Blocks ads, trackers, tracking cookies and cookie banners on all sites (EasyList, EasyPrivacy, EasyList Cookie List).
     - Removes tracking parameters from links, element picker ("Hide an element"), per-site switch.
     - Works on video sites too (YouTube, Twitch); these sites change often.
     - No telemetry, no accounts, no remote configuration. MIT licence.
     Install: from the browser stores (links in the README once live), or download ad-shield-2.0.0.zip below and follow INSTALL.txt inside.
     ```
   - Attach both files from `dist/` (drag them into the box): `ad-shield-2.0.0.zip` and
     `ad-shield-2.0.0-store.zip`.
   - **Publish release**.

## C. Chrome Web Store (chrome.google.com/webstore/devconsole)

1. **Add new item** › **Choose file** › `dist/ad-shield-2.0.0-store.zip` › **Upload**.
2. **Store listing** tab:
   | Field | What to put |
   |---|---|
   | Description | "Detailed description" block from `listing.md` (the text between the ``` lines) |
   | Category | Productivity (or "Tools" if that is the list shown) |
   | Language | English |
   | Store icon | `images/store-icon-128.png` |
   | Global promo video | leave empty |
   | Screenshots | `images/shot-1-popup.png`, `shot-2-settings.png`, `shot-3-filters.png`, `shot-4-privacy.png`, `shot-5-support.png` (in this order) |
   | Small promo tile | `images/promo-small.png` |
   | Marquee promo tile | `images/promo-marquee.png` |
   | Official URL | none |
   | Homepage URL | `https://marsselal.github.io/ad-shield/` |
   | Support URL | `https://github.com/MarsselAL/ad-shield/issues` |
   | Mature content | No |
   The summary is taken from the manifest; nothing to type. Click **Save draft**.
3. **Privacy** tab (all text in `permissions.md`):
   - Single purpose: paste the one sentence under "Single purpose".
   - Each permission box: paste its row from the "Permission justifications" table
     (`declarativeNetRequest`, `declarativeNetRequestFeedback`, `scripting`, `storage`,
     `unlimitedStorage`, `alarms`, host permission).
   - Remote code: **No, I am not using remote code**.
   - Data usage: tick **none** of the data types; tick the **three** certifications.
   - Privacy policy URL: `https://marsselal.github.io/ad-shield/store/privacy-policy.html`
   - **Save draft**.
4. **Distribution** tab: Free; Visibility **Unlisted** for the first review (switch to Public
   after it passes) or Public if you prefer; Regions: all. **Save draft**.
5. **Test instructions** (if the tab is shown): paste the "Test instructions" value from the
   table at the end of `listing.md`.
6. Account tab (once): a contact e-mail must be verified; it is shown publicly on the listing.
7. Click **Submit for review**. Optional tick "Publish automatically after review": your choice.
   Do not resubmit while it is in review (that restarts the queue).

## E. Microsoft Edge Add-ons (partner.microsoft.com › Edge › Extensions overview)

1. **Create new extension** › upload `dist/ad-shield-2.0.0-store.zip`.
2. **Availability**: Visibility **Public**, Markets: all. Save.
3. **Properties**: Category **Productivity**; Privacy policy: **Yes**, URL
   `https://marsselal.github.io/ad-shield/store/privacy-policy.html`; Website
   `https://marsselal.github.io/ad-shield/`; Support contact `https://github.com/MarsselAL/ad-shield/issues`;
   Mature content: No. Save.
4. **Store listings** › English › Edit:
   | Field | What to put |
   |---|---|
   | Description | "Detailed description" from `listing.md` |
   | Short description | the 117-character summary from `listing.md` |
   | Extension logo | `images/store-icon-300.png` (300x300; Edge recommends 300, accepts 128 and up) |
   | Small promotional tile | `images/promo-small.png` |
   | Screenshots | `shot-1` … `shot-5` |
   | Large promotional tile | `images/promo-marquee.png` (optional) |
   | YouTube video URL | empty |
   | Search terms | `ad blocker`, `privacy`, `tracker blocker`, `cookie banner`, `adblock` |
   Save.
5. **Submit** › "Notes for certification": paste the test instructions from `listing.md` and,
   below them, the permission table from `permissions.md`. Click **Publish**.

## O. Opera add-ons (addons.opera.com/developer)

1. Sign in › **Upload extension** › `dist/ad-shield-2.0.0-store.zip`.
2. Fill in:
   | Field | What to put |
   |---|---|
   | Name | `Ad Shield` (no "Opera" in the name) |
   | Summary | the 117-character summary from `listing.md` |
   | Description | "Detailed description" from `listing.md` |
   | Category | Productivity (or Privacy & Security if offered) |
   | Icons | 64x64 `images/store-icon-64.png`, 128x128 `images/store-icon-128.png` |
   | Screenshots | `shot-1` … `shot-5` |
   | License | MIT |
   | Source code URL | `https://github.com/MarsselAL/ad-shield` |
   | Homepage | `https://marsselal.github.io/ad-shield/` |
   | Privacy policy | `https://marsselal.github.io/ad-shield/store/privacy-policy.html` |
   | Support | your public support e-mail, or the issues URL |
3. Notes for the moderator (paste):
   ```
   Ad blocker built on declarativeNetRequest. No account needed: install, open any news site, click the icon to see counts. Settings: right-click the icon > Options.
   The "Remove tracking parameters" option removes known tracking parameters only (utm_*, fbclid, gclid...). It adds, replaces or redirects no referral or affiliate parameters.
   Turn off Opera's built-in ad blocker when comparing.
   ```
4. **Submit for moderation**. Opera reviews by hand; it can take weeks.

## After the stores approve

1. Put the store links in `README.md` (the "Install" section has placeholders).
2. Chrome: switch Unlisted → Public when you are happy.
3. Watch reviews and GitHub issues for a few days (`release.md` step 8).
