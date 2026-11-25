# Review risks and mitigations (research of 21 Nov 2026)

Evidence quality: I found **no official Chrome Web Store rule that bans ad blockers or
YouTube/Twitch ad blocking**. What exists is general policy plus anecdotal developer reports.
Treat anecdotes as unverified. Re-check the linked policy pages on submission day.

## Sources
- [Review process](https://developer.chrome.com/docs/webstore/review-process): review time varies; broad host permissions, sensitive execution permissions and lots of / hard-to-review code are listed as factors that lengthen it.
- [Troubleshooting violations](https://developer.chrome.com/docs/webstore/troubleshooting): categories (excessive permissions, remotely hosted code, functionality, misleading metadata, single purpose).
- [Images](https://developer.chrome.com/docs/webstore/images), [affiliate-ads policy update 2025](https://developer.chrome.com/blog/cws-policy-update-affiliate-ads-2025).
- Forum anecdotes: [Blockify removal citing Single Purpose](https://getblockify.com/update); [AdGuard on review issues](https://adguard.com/en/blog/review-issues-in-chrome-web-store.html); [Chromium-extensions: ad-blocking scripts update](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/CUIb7gop9sQ); [PSA: longer review times](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/VJ6DcpEn51Y).

## Top risks (ordered)

### 1. "Single purpose" (policy) — medium-high
Ad Shield bundles: ad/tracker blocking, cookie-banner handling (incl. auto-reject), tracking
cookie stripping, URL-parameter stripping, element picker, YouTube scriptlets, Twitch stream
rewriting, a list updater, and a donation link. Google has enforced Single Purpose against an
ad blocker that also did "promotions" (Blockify, 2025, one-sided account).
Mitigation: one-sentence purpose in `permissions.md` ("blocks unwanted content on web pages");
describe every feature as a facet of that; no unrelated features (no new-tab page, search
changes, shopping, affiliates). Keep donation text modest (one link in the listing).

### 2. Broad host permissions + page-script injection → in-depth review delay — high likelihood
`<all_urls>` plus `scripting` plus content scripts in `MAIN` world (Twitch, YouTube scriptlets
that patch `fetch`, `JSON.parse`, `Response.json`, `XMLHttpRequest`, iframes) is exactly what the
review docs say slows review (days to weeks; first review often longest). Not a rejection by
itself. Mitigations: clear justifications (`permissions.md`); open-source link; put test notes in
the dashboard ("No account needed…"); submit as **Unlisted** first; do not resubmit repeatedly
(restarts the queue). `declarativeNetRequest` modifyHeaders on all URLs needs host access, so
`<all_urls>` cannot be narrowed without losing cookie stripping/cosmetics. The redundant
`*://*.twitch.tv/*` host permission was removed (content_scripts matches are separate and unchanged).

### 3. Circumventing YouTube/Twitch ads → TOS exposure, possible manual flag — medium
Google owns YouTube; YouTube's ToS forbids circumventing ads, but the Web Store has long hosted
uBlock Origin Lite, AdGuard, AdBlock, etc., which block YouTube ads. Store policy ties to
extension behaviour (deception, malware, permissions), not to third-party ToS; but a reviewer who
sees a listing headlined "removes YouTube ads" is more likely to look closer. Twitch playlist
rewriting is more unusual (plays a different "player type" stream), and README itself says Twitch
blocking is not yet proven live.
Mitigations: keep YouTube/Twitch out of the name, summary and icon; mention them once, factually,
in the long description (already done); be honest about limits; keep a **fallback build** without
the `scriptlets` + Twitch content scripts (manifest without `content_scripts`, `scripting` kept
for CSS) ready, so a rejection on this ground can be resolved in one resubmission with a smaller
extension instead of arguing. Decision for Marsel: submit the full build first, or the lean build
first and add video features in an update (updates are reviewed too, but a live listing with a
history is calmer than a first-submission rejection).

### 4. Remote hosted code (policy) — low, but be able to explain
The weekly list download is the only external fetch. It is data converted to declarative rules
(verified; see `permissions.md`). Answer "No remote code". Reviewers sometimes flag any external
`fetch` in an ad blocker, so the justification text is in the dashboard answers and the privacy
policy states the three exact URLs. uBlock-style `$redirect`/script injection from lists is not
implemented, which helps.

### 5. Metadata and manifest hygiene — certain if ignored
- `description` in manifest is 117 chars (limit 132): fixed.
- Product name "Ad Shield": I believe a commercial anti-adblock-recovery company uses the same
  or a near name; I could not verify. Search the Web Store, Google and USPTO/EUIPO for "Ad Shield"
  before you commit; a name clash is a classic trademark/impersonation takedown cause.
- README says "Not on the Chrome Web Store (on purpose)" and Twitch "not yet proven": update the
  README before making the repo public so the listing and the repo agree.
- Privacy policy URL must be live and reachable; developer contact e-mail must be verified in
  the dashboard (Account tab).
- Keep screenshots real (see `assets-checklist.md`): misleading imagery is a metadata violation.

### 6. Donation links with crypto addresses — low-medium, and a product decision
The Web Store has rules on payments and on deceptive/"misleading" prompts but no ban on a
donation link. The listing mentions only the Revolut link. The popup and settings page also show
USDC and BTC addresses. Risk is small, but crypto addresses in an ad-blocking extension sometimes
look suspicious to a reviewer. Option: keep Revolut-only in the packaged store build (remove the
crypto lines from `src/shared/donate.js` for the store build) and keep crypto on GitHub only.
Also: never ask for ratings in exchange for anything; no nag screens.

### 7. Removal of tracking parameters (`removeparam`) — low
Chrome's 2025 affiliate policy targets extensions that *inject or replace* affiliate links; ours
only removes known tracking params (utm_*, fbclid, ...). Opera's criteria are stricter, see
`edge-opera.md`. Mention "tracking parameters, never affiliate or referral injection" if asked.

## Manifest V3 gotchas for us
- **Static rule limits**: 14,920 rules, under the guaranteed 30,000 per-extension minimum and
  the 50 enabled-ruleset cap; at most 10 rulesets enabled... we have 10 declared, 9 enabled by
  default; the guaranteed number of *enabled* static rulesets is 50 in current Chrome. Fine.
- **Dynamic rules**: up to 30,000 (regex 1,000); updater checks limits before applying.
- **`declarativeNetRequestFeedback`**: available in store builds for `getMatchedRules` (rate
  limited, 20 calls/10 min); `onRuleMatchedDebug` is unpacked-only and is not used.
- **`userScripts` API** not used (good: it needs a user toggle and extra scrutiny). We use
  `scripting.registerContentScripts` with bundled files, allowed.
- **Service worker**: `importScripts` of packaged files only.
- **Minimum Chrome 120** matches `world: 'MAIN'` content scripts support (111+) and
  `registerContentScripts` options used.
- First-time developer accounts: one-off $5 fee, 2-step verification required, and (for new
  accounts) the first submission can take up to several weeks.

## Trademarks
- Do not use YouTube, Twitch, Google, Amazon, DuckDuckGo, EasyList logos or icons anywhere
  (icon, tile, screenshots).
- Name/title/summary: no "YouTube", "Twitch", "for YouTube". In the description use plain,
  descriptive mentions ("Works on YouTube and Twitch") plus the non-affiliation sentence
  (already in `listing.md`). Names as nominative reference are generally fine; headlines are not.
- "Ad Shield" itself: see risk 5. "Chrome" is fine in the sentence "for Chrome"; do not use the
  Chrome logo.

## Suggested submission order
1. Fix manifest description; decide Twitch host line and crypto lines; update README.
2. Make repo public; enable Pages, Issues; fill privacy-policy contact.
3. Take screenshots; build zip; test the zip loaded unpacked.
4. Submit to Chrome **Unlisted** with test notes; when approved, switch to Public.
5. Edge and Opera after Chrome passes (`edge-opera.md`).

### Rejection on record: keyword spam (Yellow Argon), 22 Nov 2026
The first submission was rejected for "excessive and / or irrelevant keywords" over the
disclaimer line "not affiliated with ... YouTube, Google, Twitch, Amazon, EasyList or
DuckDuckGo". A list of brand names reads as keyword stuffing even inside a disclaimer.
Rule from now on: the store description names no third-party brands; credits and licences
live in NOTICE.md in the repo. The manifest summary still says "Twitch video-ad support"
(one functional mention, not flagged); drop it in the next package if a reviewer objects.
