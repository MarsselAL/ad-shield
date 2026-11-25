# AdBrake roadmap from the 25 Nov 2026 research

Six research passes (public sources only: code, docs, issue trackers, forums, store reviews; no leaked
material, nothing decompiled). Full notes with sources and CHECKED / REPORTED / INFERRED labels:
`docs/research-2026-11-25/r1..r6`. This file is the decision layer.

## Ground rules

- **AdBrake is MIT.** GPL code (uBlock Origin, uBO Lite, AdGuard extension, Privacy Badger, Ghostery
  extension, AutoFR, ScamSniffer) is ideas only: read it, write our own.
- **Reusable:** DuckDuckGo code (Apache-2.0), Brave data/code (MPL-2.0), DDG autoconsent (MPL-2.0),
  AdGuard cname-trackers and AGTree (MIT), Phishing.Database (MIT), polkadot-js/phishing (Apache-2.0),
  eth-phishing-detect (DBAD, credit). Credit each in `rules/NOTICE.md`.
- **Do not use:** DDG Tracker Radar and Ghostery TrackerDB data (CC BY-NC-SA), OpenPhish, PhishTank,
  URLhaus feeds (licence / key terms).
- **Store policy (Edge 1.2, Chrome MV3):** data may be downloaded if it only switches on behaviour already
  in the package; no downloaded code, no "interpreter" for fetched commands. Every new capability ships
  through a store release.

## Phase 1: quick, low-risk wins (one release)

| # | Change | Where | Source / licence |
|---|---|---|---|
| 1 | Stop loading 540 KB of generic CSS into every frame: trim to top selectors, rest per site, cookies CSS top frame only | `src/shared/blocking.js:286-298` (checked) | own code |
| 2 | Stop the per-page lookup in 1.8 MB `site.json`/`generic.json` from cold-starting the worker each time: shard by host | `src/content/general.js:52`, `src/background/general.js` | own code |
| 3 | Global Privacy Control: `Sec-GPC: 1` DNR header + `navigator.globalPrivacyControl` only if absent, per-site off | new rule + MAIN script | DDG (Apache) |
| 4 | Update autoconsent 17.2.0 to 18.x, add an update script | `vendor/autoconsent`, `tools/vendor_autoconsent.py` | MPL-2.0 |
| 5 | Add ~37 missing tracking params (`_gl`, `mtm_cid`, `pk_cid`, ...) | `rules/removeparams.txt` | Brave (MPL) / DDG (Apache) |
| 6 | Surrogate scripts for blocked GA/GTM/GPT/adsbygoogle/IMA so pages don't break | redirect resources | DDG (Apache) |
| 7 | AMP and redirect-hop unwrapping via DNR `regexSubstitution` | new ruleset | DDG ampProtection, Brave debounce.json |

## Phase 2: video (measure before changing)

- **YouTube start delay.** Cause is known (SABR backoff of 4-9 s on videos that had a pre-roll,
  `docs/DESIGN-v2.md:110`). No new public fix since 11-22. uBO says fake buffering is account-based, and
  our tests ran signed out. **First run `tools/youtube_test.py` on a signed-in profile** and split the
  time into backoff, recover reload and SSAP ads. Then, by result:
  - stalled-start detector (0x0 resolution, empty buffer > 2 s, no ad) that retries once with a second
    request-body tag (`src/scriptlets/lib.js:598-684`);
  - one `seekTo(duration)` per SSAP ad only (`lib.js:1020, 1056`), watching for the old freeze;
  - embed support (`WEB_EMBEDDED_PLAYER` variant);
  - check /shorts, /live, youtu.be against the redirect rule (`rules/youtube.json:4`).
  - Not recommended blind: reloading earlier in `lib.js:1571-1574`; the code records that early reloads
    were swallowed (measured 2026-11-22).
- **Twitch.** Purple (#112, #113) and TTV-AB (#108) got new ad-breakage reports on 11-25 with no
  analysis yet; Twitch likely changed something 11-24/25. Reproduce with our live test, then compare.

## Phase 3: Scam shield (no server needed)

1. Local phishing-domain set (Phishing.Database + eth-phishing-detect, ~500k domains) as a compact hash
   set, not DNR; warning page with "go back" / "continue anyway".
2. Wallet warnings: wrap `ethereum.request` and EIP-6963 providers; flag `eth_sign`, Permit/Permit2,
   unlimited approve, `setApprovalForAll`, scam recipient addresses. Pattern seen in Rabby (MIT) and
   Wallet Guard (Apache).
3. Lookalike-domain check (confusables, edit distance 1, keyboard typos, brand+keyword) against a
   brand allowlist; warn only.
4. ClickFix / fake-CAPTCHA guard: catch pages writing `powershell`, `mshta`, `curl | bash` to the
   clipboard alongside a "verify you are human" context.
5. Address-poisoning paste check (copied vs pasted address mismatch, in memory only).

## Phase 4: privacy extras

- CNAME-cloaked trackers (AdGuard list, MIT; ads part 14.5k domains first; measure load of the large one).
- Opt-in "Hardening" panel via the `privacy` permission at runtime: WebRTC IP leak, third-party cookies,
  hyperlink auditing.
- Warning page instead of Chrome's error for blocked top-level pages (idea from uBOL strictblock).
- Optional "Strict" fixed values for battery/screen/hardwareConcurrency (DDG approach) with site exceptions.
- **Do not ship:** canvas/audio noise (detectable, makes users more unique), LocalCDN, DNT, referrer rewriting.

## Phase 5: self-improving rules (store-safe)

1. Harden the updater first: schema checks, size caps, rollback to the packaged lists.
2. Nightly canary bot on a non-datacenter machine (YouTube blocks datacenter IPs, reported), signed out,
   5-10 YouTube/Twitch pages; log ad shown, start time, errors.
3. LLM drafts rule-data changes (selectors, JSON paths, URL patterns only) as a PR; canary re-runs;
   a person approves each one.
4. Ed25519-signed data file with sequence number, expiry and a revoke file as kill switch.
5. Opt-in "ad got through" button: user previews exactly what is sent; reports only raise priority.
- Store wording once step 4 ships: "No remote code and no tracking. Filter lists and a signed rules file
  are downloaded as data and can only adjust features already in the extension." "No telemetry" can stay
  as long as the report button is user-triggered and previewed.

## Open questions

- EasyList's licence file is missing on GitHub (CC BY-SA 3.0 per its site); confirm before redistributing.
- Edge reviewer stance on downloaded scriptlet parameters is unknown; keep scriptlet params packaged.
- No independent 2025-26 memory/speed benchmark of MV3 blockers exists; publishing our own would be a
  store advantage.
