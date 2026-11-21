# Twitch ad blocking: state of GitHub projects, 2026-11-21

Labels: CHECKED = opened via GitHub API / raw file today. REPORTED = a project's doc or an issue says so. INFERRED = my judgement.
Limits: read-only; no `gh` CLI (used api.github.com via curl, unauthenticated). Reddit, Twitch itself and the Chrome Web Store were not read. No code was run.

## 1. Project status (CHECKED unless noted)

| Project | Latest | Recent changes / issues |
|---|---|---|
| Purple (arthurbolsoni/Purple-adblock) | 2.7.3, 2026-11-09. No commit since. | 2.7.2 (11-07): removals leave no audio outside the buffered range (T-829, #112). 2.7.3: polls take turns (overlapping polls no longer give the player an older playlist after a newer one, T-831); F-28 keeps the newest live segment the player already has across blanked/merged playlists so the player is not restarted at a break end (T-832). Only open issue in window: #112 audio desync during ad (updated 11-15). |
| TTV AB (GosuDRM/TTV-AB) | v27.0.2, 2026-11-20 | 27.0.0: no pause/resume on return to native when backup has same HEVC/AV1 codec and quality (fixes audio delay, #101). 27.0.1: keeps full quality list when picture-by-picture player loads first (low-quality-stuck, #102); keeps player on backup if it polls before the backup has a new segment. 27.0.2: hides promo banners only. 26.0.x: skip holes up to 2.5 s after ~1 s frozen; gaps up to 1 s during breaks; switch to backup at once even if slightly behind (skip up to ~1.5 s); replay at most 0.5 s on switch; no player reload on fMP4 channels at break end; leave PbyP player alone. 25.0.1: accept renumbered stream after a break (#96). Open: #102 (low quality stays, LQ fallback on), #101 audio. |
| TTV LOL PRO (younesaassila) | v2.6.2 (2026-05-08); only build-script commits since | #443 closed 11-14: ads served when request params contain `play_session_id` (v1.9.4). #411 open: streams offline until refresh. #441: ads with a Portugal proxy. Proxy approach, not relevant to an in-page fix. |
| pixeltris/TwitchAdSolutions | Archived 2026-03-05, last code 2026-02-28 (v24) | No upstream changes. |
| vaft forks | happyjuniorman/TwitchAdSolutions-next v38.0.0 (2026-11-20; "Enhance HEVC stripping logic for codec mismatches"; removed uBO builds, GPLv3). Others updated: scamorza/TwitchAdBlock 2.2.4 (11-19, "bridge paced on the stream's own segment length"), Helli24, troysjanda, naustagic, xBandaku. | I did not read their code (UNKNOWN beyond commit titles). The HEVC codec-mismatch fix mirrors TTV AB 27.0.0, i.e. the same bug class. |
| AdGuard Extra | #662 (open, 11-11) "twitch ads" back, one user got eternal buffering; #665 banner ads (11-07). AdguardFilters last Twitch commit 2026-07-19 "address new Twitch ads". | Technique unknown. |
| uAssets | Last Twitch commit 2025-07-26 (experimental). | Nothing new; uBO does not do SSAI. |
| New in Nov 2026 | Many one-person MV3 wrappers of vaft (Teylersf, gabriel-catarini, Nyxia-Code ...) | Not evaluated; wrappers, no new technique found. |

## 2. What Twitch changed (mostly REPORTED from Purple's server docs, recorded Oct 2026)

Source: https://github.com/arthurbolsoni/Purple-adblock/tree/main/docs/server (ads.md, tokens.md, techniques.md) and docs/findings/.

- CSAI is now common: DATERANGE `twitch-maf-ad` over live segments, 2-3 min after load then every 4-5 min; page then calls `edge.ads.twitch.tv/ads` (`bp=midroll`) and plays a separate video or HTML creative. A May 2026 upstream changelog said every observed channel ended breaks this way. SSAI (stitched) still exists: 11 stitched breaks in 8.7 h soak vs 115 maf-ad slots. (CHECKED docs, REPORTED server behaviour.)
- Backup player types (REPORTED, B-012): since March 2026 a token with another playerType during a break often returns a playlist with ads too. Preroll backups still get their own preroll (17 of 17 loads); midroll backups rarely carry ad segments (0 of 832 polls) BUT 251 of them announced their own break over live segments (DATERANGE only), so Purple treats a backup with its own announcement as contaminated (T-204).
- Backup token requests must carry the page's own GQL headers (Client-Integrity, X-Device-Id, Authorization, Client-Version, Client-Session-Id), T-401. With them, no ad segments in backups in 14 midrolls (CHECKED finding 2026-10-08-page-gql-headers.md).
- `PlaybackAccessToken`: the current persisted hash `0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712` and the full query honour `platform`; the older Brave hash `ed230aa1...` does not (B-030, REPORTED/observed 2026-10-07). Purple falls back to the full query (`$platform`) if the persisted query fails.
- Ad segment titles are no longer only `Amazon|id`: also `FT|n-n-n` and 10-digit numbers; `twitch-stream-source` DATERANGE equals the segment title, `live` for live. Purple reads title, DATERANGE coverage and stream-source (T-203). Ranges run slightly past the ad's segments (B-040).
- Midrolls are announced 1-3 polls ahead (stitched-ad DATERANGE with future START-DATE, DISCONTINUITY, ad EXT-X-MAP, extra prefetch line); then MEDIA-SEQUENCE stops and the playlist grows through the pod. A page request for a `picture-by-picture` master 3-14 s before a midroll is a leading indicator. Preroll playlists start at MEDIA-SEQUENCE 0 and can run into a midroll.
- A player reload with the same token right after a preroll can bring a new preroll (1 of 2).
- Twitch banners (GTA VI promo) are page UI, not ads (TTV AB 27.0.2).

## 3. Techniques that work now

1. Backup swap with live-sequence renumbering and a no-restart return: Purple 2.7.x (CHECKED release notes + findings: 2026-10-09-sequence-numbering.md, 2026-11-08-repeat-after-blanked-playlist.md). Never give the player an older playlist after a newer (polls serialised), keep the newest live segment it already holds, restart only if it would refetch.
2. Match codec/quality, avoid pause/resume on return: TTV AB 27.0.0 CHANGELOG (CHECKED); vaft-next v38 same class (REPORTED by commit title).
3. Hold the backup when the player polls before the backup has a new segment; tolerate a backup slightly behind (skip up to ~1.5 s), replay <= 0.5 s: TTV AB 26.0.2, 27.0.1 (CHECKED).
4. Clean low-quality bridge (autoplay 360p, platform android) first, HD later: TTV AB default "Low Quality Fallback"; paced bridge in scamorza 2.2.4. Costs quality for a few seconds but removes the black/spinner gap (REPORTED benefit; users of #102 say it can leave quality low until 27.0.1 fix).
5. Backup tokens with captured page GQL headers, type pinning (last clean type first) and a 5 s skip for contaminated types, own-break announcement counts as contaminated: Purple T-401, T-406, T-204 (CHECKED findings).
6. Small gap/hole skipping after ~1 s frozen (<= 1 s in break, <= 2.5 s outside): TTV AB 26.0.2/26.0.3 (CHECKED).

## 4. Where Ad Shield 2.0 likely falls short (INFERRED from reading src/config.js, gql.js, processor.js; not run)

Ranked by expected impact:

1. No clean backup means the ad plays or a spinner (docs/DESIGN-v2.md accepts this). `src/config.js:144` backupPlayerTypes = embed, site, mobile_web, popout (page token already popout, so effectively 3). Purple and TTV AB keep `autoplay`/`picture-by-picture`/`frontpage` as last resorts. Likely top cause of "not working": all types contaminated => original with ads passes through. Consider optional autoplay/android 360p bridge (TTV AB), at least as a last resort rather than ad.
2. Stale persisted-query hash: `src/config.js:112` uses the Brave hash `ed230aa1...`; Purple documents `0828119d...` as the one honouring `platform`, with full-query fallback. `src/core/gql.js buildTokenBody` has no fallback to the full query when the persisted query fails or returns no token (parseTokenResponse returns null only). Cheap to add; if Twitch rotated hashes, every backup fails silently.
3. Contamination test: does `m3u8.hasAds` treat a backup that merely announces its own break (stitched-ad/quartile DATERANGE over live segments) as contaminated? Purple T-204 says it must. Check `src/core/m3u8.js` hasAds / processor.js:247. Also `adSegmentTitlePrefixes: ['Amazon']` (config.js:85) misses `FT|` and numeric titles, unless the non-`live` rule covers them (not verified).
4. Return/sequence handling: Purple's 2.7.3 fixes (serialised polls, keep newest live segment, no restart that refetches) and TTV AB 25.0.1 (accept page renumbering after a break) address freezes and desync at break end. Ours: `resequence` in m3u8.js and `nativeSwitchBackPolls: 2` (config.js:175); overlapping polls are not obviously serialised (check processor.js ~290-340, single in-flight search exists, but the poll answer order is not guaranteed).
5. No frozen-gap skipper and only one pause/play nudge (src/page/health.js): TTV AB's 1-2.5 s hole skipping is what addresses stalls at small gaps. DESIGN-v2 removed seeks deliberately; trade-off.
6. `backupPollDeadlineMs: 1800` (config.js:173) serving stripped when search exceeds it: stripped playlist with ads removed is what vaft #404 says freezes. Check how often it fires.
7. Client-side `twitch-maf-ad`: we pass it through (config.js:67). The ad then plays as a separate video beside the stream via `edge.ads.twitch.tv`, which this technique does not block; TTV AB #98 handled by blocking/spoofing ad requests and hiding/muting the beside-player ad. Likely a visible "ads still showing" cause as CSAI is the dominant delivery. Candidate: DNR block of `edge.ads.twitch.tv/ads*` (INFERRED; consequences for the player unverified) plus hide the ad UI.

## 5. Unknown

- Whether Twitch changed anything between 11-09 and 11-21: no new Purple release, TTV AB changes are bug fixes, no new Twitch-side change reported in issues in that window.
- The actual cause of the user's report: no details; items above are ranked hypotheses, not reproductions.
- vaft fork code, AdGuard Extra technique, Reddit/Discord reports.

## Sources
- https://github.com/arthurbolsoni/Purple-adblock (commits, release 2.7.3, docs/server/*.md, docs/findings/2026-10-08-page-gql-headers.md, 2026-10-08-backup-type-pinning.md, serviceWorker/src/modules/stream/interface/stream.enum.ts)
- https://github.com/GosuDRM/TTV-AB (CHANGELOG.md, README.md, issues #92 #96 #98 #101 #102, src/modules/constants.ts)
- https://github.com/younesaassila/ttv-lol-pro (commits, issues)
- https://github.com/happyjuniorman/TwitchAdSolutions-next, https://github.com/scamorza/TwitchAdBlock (commit titles only)
- https://github.com/AdguardTeam/AdGuardExtra/issues/662, /665; https://github.com/AdguardTeam/AdguardFilters/commit/b1dc6b1bb2d6feb10b18db4957dc71bb8cd42e0d
- https://github.com/uBlockOrigin/uAssets (commit search "twitch")
