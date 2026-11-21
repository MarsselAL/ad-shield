# Microsoft Edge Add-ons and Opera add-ons

Both are Chromium-based, so the same MV3 zip loads. Sources:
[Edge extensions docs](https://learn.microsoft.com/microsoft-edge/extensions/),
[Edge developer policies](https://learn.microsoft.com/legal/microsoft-edge/extensions/developer-policies),
[Opera publishing guidelines](https://help.opera.com/en/extensions/publishing-guidelines/),
[Opera acceptance criteria](https://help.opera.com/en/extensions/acceptance-criteria/).
Check them on the day; some Opera pages are undated.

## Microsoft Edge Add-ons (Partner Center)
| Item | Detail |
|---|---|
| Account | Free developer registration with a Microsoft account, via Partner Center (Edge program); individual or company. Marsel does this himself. |
| Package | The same zip. No code change needed; Edge ignores unknown Chrome-only keys. |
| Listing | Name, short description, detailed description, category (e.g. Productivity), search terms, logo (128px+), screenshots (1280x800 or 640x480), small promo tile 440x280 advisable, privacy policy URL, support URL, website URL. Reuse `listing.md`. |
| Testing notes | Edge requires the product to be fully testable and wants testing steps at submission ("Notes for certification"). Paste the test instructions from `listing.md`. |
| Policies | Single purpose with narrow functionality; privacy policy mandatory when personal data handled (ours: none, still provide the URL); no remote code; permission justification. Review usually faster than Chrome (days) but varies. |
| Availability | Choose markets and visibility (public). |
| Updates | Upload new zip in the same Partner Center product; reviewed again. |
| Differences from Chrome | No "Privacy practices" tab: answers are in the submission form/notes instead (reuse `permissions.md`). Edge has no per-permission justification boxes; add the table to the certification notes. |

## Opera add-ons (addons.opera.com)
| Item | Detail |
|---|---|
| Account | Free Opera add-ons developer account (sign in at addons.opera.com, "Upload extension"). |
| Package | Chrome MV3 zip works, but Opera officially documents installing from Chrome Web Store with "Install Chrome Extensions" and its own upload (`.nex`/zip). Opera supports MV3 `declarativeNetRequest`; test the zip in Opera before submitting (Opera also has its own built-in ad blocker; conflicts possible, say "turn off the built-in blocker to compare"). |
| Listing | Name (**no "Opera" in the title**), summary, long description, icon (64x64 and 128x128), screenshots (1280x800 recommended), license, source URL, support e-mail. Make the 64px icon from `icon128.png`. |
| Acceptance criteria to watch | One clearly stated purpose; no changing of referral parameters and no interfering with Opera's monetisation (affiliate) mechanisms. **Our `removeparam` ruleset strips utm_*/fbclid/gclid-style parameters from links**, so state in the notes: "removes known tracking parameters only; adds, replaces or redirects no referral or affiliate parameters". If a moderator objects, the setting "Remove tracking parameters" can ship default-off for Opera (decision for Marsel; needs a code/build change, not done here). |
| Review | Manual by moderators; community reports mention long waits (weeks). No ad-blocker-specific policy found. |
| Updates | Upload a new version in the developer dashboard; reviewed again. |

## Decisions for Marsel
1. Submit Chrome first; Edge when Chrome passes; Opera last (slowest, fussiest).
2. Opera: ship with tracking-parameter removal on or off?
3. Same name on all three; check "Ad Shield" availability and clashes first (`review-risks.md` risk 5).
