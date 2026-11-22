# YouTube enforcement wall - research 2026-11-22
Labels: CHECKED (opened), REPORTED, INFERRED. Sources via api.github.com / raw.githubusercontent.com.

## Answer
- CHECKED: no uBO, AdGuard or Brave change in 2026-11-19..22 deals with the "Ad blockers are not allowed" dialog. No filter in uBO quick-fixes.txt, filters.txt, filters-2026.txt, unbreak.txt mentions enforcementMessageViewModel, auxiliaryUi, adBlockingInfo, playabilityStatus pruning (grep). uBO does not prune the dialog keys.
- CHECKED: the YouTube block of quick-fixes.txt is unchanged in the window except one line. Commits touching quick-fixes.txt since 11-19: 69584ba, 38f162e, 10a1fde, 203e7a6, 9ccf3c1, 1cab9ff. Only 10a1fde (2026-11-20 16:36Z "update quick") touches YouTube: line 78 `rmnt, script, window\,"fetch"` -> `rmnt, script, 'window,"fetch"'` (quoting fix). The others are socialxup.com edits (AdguardFilters#245421).
- CHECKED: issue uBlockOrigin/uAssets#30157 last updated 2026-11-21T10:43Z; no comments after 11-21 00:41Z (API since=...). Search of uAssets issues for "enforcement popup"/"ad blockers are not allowed": no new issue (only #30157, #30158 and old 2023-25 ones).
- CHECKED: web search found nothing from Nov 2026 about the popup (only 2023 coverage).
- CHECKED: AdguardFilters#246295 (open, updated 11-22 11:43Z): bot-forwarded user reports "ads not blocked since ~11-20/22", "black screen", Windows-only failures. No popup text, no new fix. Commit search on AdguardFilters and brave/adblock-lists returned 0 results (search API limited; UNKNOWN whether changes exist).
- CHECKED (thread, 11-20/21): fake buffering is account-based per stephenhawk8054; fix = uBO tries tag list and reloads the player; "uBlock filters - Experimental" list recommended.

## Keys carrying the popup (not found in any source)
INFERRED only from previous knowledge: playerResponse.auxiliaryUi.messageRenderers.enforcementMessageViewModel / playabilityStatus UNPLAYABLE+errorScreen; uBO has no rule that prunes these. The only uBO measures against enforcement are (a) stubbing onAbnormalityDetected, (b) the userAgent tag + body edits that make YouTube return a response without ad data, (c) removing inline scripts that re-wrap fetch.

## uBO YouTube lines (quick-fixes.txt, master 2026-11-22, https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt)
- L25 rpnt serverContract patch (tags channel,yahi,inline,oaeb; embed channel,eafg; premium exempt; fake-buffering detect via Map.prototype.has('onSnackbarMessage') + Uint8Array len 104/105 push; seek to end for "SSAP, AD"; Promise.prototype.then proxy neutralising callbacks containing onAbnormalityDetected; 3037019 UNPLAYABLE -> next tag + loadVideoById).
- L26-31 trusted-edit-inbound-object JSON.stringify body edits by tag; referer #reloadxhr; strip "; tag" from createCommentParams userAgent.
- L33-35 same for /embed (WEB_EMBEDDED_PLAYER, eafg=eAFgAQ).
- L54 `nostif, ()\,a\,b);, 5000` ; L55 `nano-stb, [native code], 17000, 0.001`.
- L57 (commented) onAbnormalityDetected replace in /s/_/ytmainappweb/_/js/ (only if cap_html_filtering).
- L60-87 json-prune/replace of adPlacements, adSlots, playerAds, "no_ads" in fetch, xhr (player, get_watch, playlist, watch, resolve_url).
- L78 `rmnt, script, 'window,"fetch"'`, L88 `##^script[id]:has-text(window,"fetch")`, L90-91 `trusted-prevent-dom-bypass, Node.prototype.appendChild, fetch` and `..., Request` : stop YouTube's inline script/iframe that grabs a clean window.fetch/Request (bypasses page hooks).
- L109 `/\.googlevideo\.com\/videoplayback\?expire=.../$xhr,3p,method=get,domain=www.youtube.com` (blocks stale-expire videoplayback probes).
- L113 toast removal.

## Gaps vs our rules (scriptlets.json ids youtube, youtube-skip; rules/youtube.json)
1. INFERRED likely: no anti-bypass of fetch (uBO L78, L88, L90, L91). Our hooks can be skipped if YouTube re-grabs fetch/Request from a fresh iframe or injected script; then ad keys and attestation-tag edits are not applied -> detection. No equivalent in rules/scriptlets.json or src/scriptlets/lib.js (grep appendChild/dom-bypass: none).
2. INFERRED: no onAbnormalityDetected neutraliser (L25 Promise.prototype.then proxy; L57). We chose not to hook (DESIGN-v2). This is the function YouTube uses to report abnormality (hook detection) and is what uBO still stubs.
3. INFERRED: no tag rotation/reload (L25): only oaeb always-on; if account is served "channel"/other state or oaeb fails, uBO falls back; we do not. Also no premium exemption.
4. Lower: no L109 expired videoplayback block; no L31 userAgent cleaning (we add no tag, so n/a); no L54 nostif.
5. Not a gap: ad-key pruning (L60-87) is covered; popup keys are pruned by nobody.

## Unknown
Actual popup response key today; whether any Brave/AdGuard fix exists (API search returned nothing); what YouTube changed on 11-22 (AdGuard users report ads not blocked 11-22).
