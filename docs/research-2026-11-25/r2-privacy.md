# R2: Privacy hardening for AdBrake (MV3), research of 2026-11-25

Labels: CHECKED = I opened the source or ran code on it. REPORTED = a source says so, not verified by me. INFERRED = my reasoning.
Not repeated: Privacy Badger heuristics and the short privacy list (design notes sections 1 and 5).
Repo facts CHECKED: manifest has no `privacy` permission, no `web_accessible_resources`, no GPC code; vendored autoconsent = 17.2.0 (vendor/autoconsent/VERSION.json); `acConfig` in src/background/general.js:355 uses autoAction optOut, prehide on, heuristics OFF; rules/removeparams.txt has 46 exact names; rules/cookie_strip.json has 4 rules (third-party cookie/set-cookie removal for listed domains).

## Ranked summary (value / risk)
1. GPC header + `navigator.globalPrivacyControl`. Tiny, almost no breakage, legal effect in some US states.
2. Update vendored autoconsent 17.2.0 -> 18.11.0 and add a re-vendor script.
3. Add about 25 vetted tracking params (Brave MPL-2.0, DDG Apache-2.0 as reference).
4. CNAME-cloaked tracker blocking from AdGuard cname-trackers (MIT) via DNR.
5. Opt-in "Hardening" panel using optional `privacy` permission: WebRTC policy, hyperlink auditing, third-party cookies, Topics/Fledge/ad-measurement off.
6. Redirect unwrapping: Brave debounce.json (MPL-2.0) and DDG AMP regexes (Apache-2.0).
7. Block known fingerprinting services by domain plus `ping` requests (no value spoofing).
8. Optional "Strict" toggle: uniform values for rarely-used APIs (battery, screen, hardwareConcurrency) as DDG does.
Skip: canvas/audio noise, LocalCDN-style replacement, DNT header, Topics-specific work.

---
## 1. Cookie consent

**Facts**
- DDG autoconsent: MPL-2.0 (CHECKED, github.com/duckduckgo/autoconsent). npm latest 18.11.0 published 2026-11-25; 17.2.0 was 2026-10-31 (CHECKED, registry.npmjs.org). Rule updates are largely automated "CPM crawl" PRs (CHECKED, release notes v18.11.0). rules/autoconsent has 1000+ rule files (API listing capped at 1000, so "at least"); vendored compact-rules.json holds 1355 rules (CHECKED, local).
- It has JSON rules, class rules, and a text-based heuristic detector (docs/heuristic-detection.md, CHECKED) with negatives and a literal prefilter for speed.
- Used by DuckDuckGo apps (README, CHECKED) and by Ghostery: ghostery-extension package.json depends on `@duckduckgo/autoconsent ^18.11.0` (CHECKED). So "Ghostery Never-Consent" is the same engine, so no separate rule coverage to compare. Ghostery extension is GPL-3.0 (CHECKED); also sets Sec-GPC in src/background/never-consent/gpc.js (CHECKED).
- Consent-O-Matic (Aarhus): "200+ CMPs", declarative detectors and methods, user chooses granular purposes (README, CHECKED). GitHub licence shows "Other/NOASSERTION" (CHECKED via API), last push 2026-02-07, last release v1.1.5 2025-06-17 (CHECKED). Licence unclear, so do not reuse its rules.
- I Still Don't Care About Cookies: original sold to Avast in 2022 (REPORTED, The Register 2022-09-21, ghacks); fork exists. A forum post claims it hides banners and sometimes accepts (REPORTED, unverified). Hide or accept is not rejecting.
- Study: Demir et al., PoPETs 2024 "A Large-Scale Study of Cookie Banner Interaction Tools and their Impact on Users' Privacy": extensions cut cookie counts, but all modes except reject-all increased tracking requests (CHECKED, abstract at petsymposium.org/popets/2024/popets-2024-0002.php). Tools tested include IDCAC and Consent-O-Matic; I could not read the full PDF, so per-tool coverage numbers are UNKNOWN. Another study found Consent-O-Matic accepted/handled banners on under 35% of sites with banners vs 50%+ for Priv-Accept (REPORTED, older, arXiv 2109.00395).

**Verdict:** AdBrake's choice is right. Best-maintained engine, permissive-enough licence (MPL-2.0 file-level; keep unmodified file + licence, already done), same engine as Ghostery. Reject mode (`optOut`) is the only mode that did not raise tracking (Demir).
**To do:**
- Re-vendor 18.x (five weeks stale, rules ship weekly). Script: npm pack, verify integrity (VERSION.json already stores sha512).
- Evaluate `enableHeuristicDetection: true` behind a flag: catches unknown CMPs but risk of clicking the wrong button (INFERRED); test against autoconsent's own test suite and top sites first.
- Keep EasyList cookie cosmetic rules as the fallback (hides, does not reject).
**Speed:** AdBrake already filters compact rules per URL/frame (`filterCompactRules`) and caps prehide at 2s; keep.
**Breakage:** low-medium (wrong click on odd banners); mitigate with per-site off switch.

## 2. Tracking parameters and redirects

| Source | Licence | Size / notes |
|---|---|---|
| Brave `brave-lists/query-filter.json` | MPL-2.0 (repo LICENSE, CHECKED) | 4 entries: 65 global params + instagram 3, twitter 5, youtube 1 (CHECKED) |
| Brave `debounce.json` | MPL-2.0 | 48 entries: 33 redirect(param), 10 regex-path, 4 base64+redirect, 1 template (CHECKED) |
| Brave `clean-urls.json` | MPL-2.0 | 51 site-specific entries for "copy clean link" (CHECKED) |
| DDG privacy-configuration `tracking-parameters.json`, `amp-links.json` | Apache-2.0 (LICENSE text CHECKED; GitHub API says NOASSERTION) | tracking-parameters: about 25 names; AMP: regex formats + keywords + 4 exceptions |
| ClearURLs/Rules `data.min.json` | LGPL-3.0 (CHECKED) | 206 providers, 733 rules, 65 redirections (CHECKED, counted). Rules are regexes |
| AdGuard TrackParamFilter (general_url.txt 21 KB, specific.txt 153 KB) | repo GPL-3.0 (CHECKED) | many `$removeparam=/regex/`; ideas only |

- DNR limits (CHECKED, developer.chrome.com declarativeNetRequest): `queryTransform.removeParams` takes literal names only, no wildcards (confirmed by repo comment in removeparams.txt); regex rules max 1000 per type, regex under 2 KB; static 30,000 guaranteed rules, 50 enabled rulesets; dynamic 30,000 of which 5,000 "unsafe" (redirect and modifyHeaders count as unsafe). So regex-style AdGuard/ClearURLs rules cannot be converted 1:1.
- Brave params not yet in AdBrake, low-collision (CHECKED by diff): `_gl, mtm_cid, pk_cid, _branch_match_id, _branch_referrer, sc_customer, sc_eh, sc_uid, sfmc_activityid, sfmc_id, vero_conv, oft_*, ss_email_id, bsft_uid, bsft_clkid, irclickid, at_recipient_id, at_recipient_list, ml_subscriber, ml_subscriber_hash, guce_referrer, guce_referrer_sig, fb_action_ids, fb_comment_id, et_rid, stkn, syclid, ymclid, unicorn_click_id, sms_click, sms_source, sms_uph, bbeml, __s, _bhlid, ref_src, ref_url`. Do NOT add generic `s`, `t`, `a`, `si` (Brave scopes them to one site; AdBrake's builder refuses generic names, correctly).
- Redirect unwrapping (debounce): DNR `regexSubstitution` replaces first match with capture groups (CHECKED) but cannot percent-decode (INFERRED), and Brave's targets are percent-encoded or base64 URLs. So pure DNR works only for unencoded targets (DDG AMP formats such as `google.*/amp/s/(...)`, `*.ampproject.org/c/s/(...)`). Encoded cases need `webNavigation.onBeforeNavigate` + `tabs.update` from the service worker (INFERRED; flash of the redirector request).
- DDG AMP: 1 to 3 regex rules, tiny. Value falls as AMP fades (INFERRED).
**Best source:** own list, seeded from Brave (MPL-2.0) and DDG (Apache-2.0) with attribution in rules/NOTICE.md. Parameter names are facts, but treat file-level copies as licensed. Use ClearURLs/AdGuard only as a cross-check.
**Breakage:** very low for named IDs; the generated rules match case-sensitively (CHECKED in removeparam.json), so list common case variants if seen.

## 3. Fingerprinting

**What vendors do**
- Brave farbling: seed per session, per eTLD+1, per storage area; third parties share the top-level seed; claim is that randomizing one input "poisons" a hashed fingerprint (CHECKED, brave-browser wiki Fingerprinting-Protections). Brave also changes 6 attributes (audio, canvas, plugins, deviceMemory, hardwareConcurrency, screenResolution), which bot detectors flag (REPORTED, arXiv 2406.07647).
- Firefox: RFP (uniform values, strict) vs FPP (canvas noise per eTLD+1/session). arkenfox wiki: "all randomizing can be detected", fools only naive scripts (REPORTED via search snippet; page 404 for me). A Jan 2026 Privacy Guides post says FPP canvas randomization is broken in recent builds (REPORTED, one user).
- Tor: uniformity, "one fingerprint for all" (REPORTED, arXiv 1905.01051).
- JShelter: GPL-3.0 (CHECKED), levels, farbling, fingerprint detector; paper arXiv 2204.01392 (CHECKED abstract; found sensor-timestamp boot-time leak). CanvasBlocker: MPL-2.0 (CHECKED), active (push 2026-09-07); Firefox-oriented (REPORTED).
- Research: Nguyen and Vadrevu, WWW 2025, "Breaking the Shield": no fully deployable canvas defense; randomization-based ones across 18 extensions have exploitable weaknesses (REPORTED from abstract summaries; DOI 10.1145/3696410.3714713; full text not opened). Kauppinen thesis: randomizing tools can make users more identifiable (REPORTED). Luo, Ritter, Savage, Voelker, IMC 2025: canvas fingerprinting on 12.7% of top 20k sites, and fingerprinting services can be told apart by their distinct test canvases (CHECKED, PDF text). That favours blocking the few big services by domain.
- EFF Cover Your Tracks: calls Tor Browser the most realistic protection; suggests Privacy Badger, Disconnect, NoScript; counts installed extensions among attributes (CHECKED, coveryourtracks.eff.org/about). No explicit stance on randomization.
- DDG ships (Apache-2.0 content-scope-scripts, CHECKED): battery spoof (charging true, level 1), hardware (`hardwareConcurrency`=4, `deviceMemory`=8, keyboard undefined), screen (colorDepth/pixelDepth 24, availTop/Left 0), canvas (gated by `additionalEnabledCheck`; 35 site exceptions), audio (state disabled), referrer (JS `document.referrer` trimmed to origin), GPC (property). Exception counts: hardware 15, screen 5, battery 1, canvas 35 (CHECKED): shows canvas is the breakage-heavy one.

**Recommendation (INFERRED from the above)**
- Do not ship per-site noise in an extension: detectable, per-user stable signal, and MAIN-world prototype patching at document_start on all frames costs speed and can be sniffed.
- Safe set: block known fingerprinting services by domain (EasyPrivacy already in; add curated hosts); keep DNR `ping`/sendBeacon block on third parties; optional uniform values for battery/screen/hardware (DDG numbers) in a "Strict" toggle with a site exception list. Gain is small if only AdBrake users share the value, so label it honestly.
- Never claim anti-fingerprinting beyond this; Tor/Mullvad Browser are the real answer.

## 4. Network-level and Chrome-API items

**CNAME cloaking**
- Chrome has no extension API to resolve DNS, so CNAME uncloaking is list-only (CHECKED, AdGuard cname-trackers README; Firefox has `dns.resolve`, REPORTED).
- AdGuard cname-trackers: MIT (CHECKED API + LICENSE), updated 2026-11-23 (CHECKED). justdomains counts (CHECKED by download): trackers 367,174; mail_trackers 332,160; clickthroughs 38,223; microsites 22,826; ads 14,490; original_trackers 99. AdGuard itself warns that blocking clickthroughs/microsites breaks pages (CHECKED README).
- Plan: ship ads (14.5k) plus a pruned trackers subset as `requestDomains` rules (a rule counts once regardless of domains, as privacy_curated already does, CHECKED; memory/load time at 367k is UNKNOWN, measure). Exclude clickthroughs, microsites, mail.
- NextDNS cname-cloaking-blocklist: could not open (repo path 404), UNKNOWN. Privacy Badger has `data/cname_domains.json` (GPL, ideas only).
- Breakage: low for ads/trackers. Effort M.

**Bounce tracking:** Chrome's mitigation (delete state of sites with no user interaction in 45 days) is active only when third-party cookies are blocked, incl. Incognito (REPORTED, privacysandbox.google.com/protections/bounce-tracking-mitigations). So the opt-in third-party cookie switch below gives it for free (INFERRED). Brave's "unlinkable bouncing" is browser-level (REPORTED). Extension-level: debounce list + trackers blocklist.

**WebRTC:** `chrome.privacy.network.webRTCIPHandlingPolicy` values: default, default_public_and_private_interfaces, default_public_interface_only, disable_non_proxied_udp (CHECKED). Use `default_public_interface_only`; `disable_non_proxied_udp` breaks calls (INFERRED). Matters mainly to VPN users; Chrome already hides LAN IPs behind mDNS (REPORTED, from memory). Needs `privacy` permission.

**chrome.privacy.websites** (CHECKED, docs): topicsEnabled, fledgeEnabled, adMeasurementEnabled can only be set to false; hyperlinkAuditingEnabled, referrersEnabled, doNotTrackEnabled, thirdPartyCookiesAllowed exist; setting needs the `privacy` permission. Permission can be requested at runtime via optional permissions (docs recommend runtime requests, CHECKED; that `privacy` specifically is optional-capable and its warning text: UNKNOWN, check in a test build).

**Topics / Privacy Sandbox 2026:** Google announced on 2025-10-17 retirement of Topics, Protected Audience, IP Protection, Related Website Sets; retains CHIPS, FedCM, Private State Tokens; third-party cookie choice stays as is (CHECKED, privacysandbox.google.com blog). Chrome 144 deprecation; removal staged in 150 (UI) and 152 (stub), may pause if usage stays high (REPORTED, blink-dev thread, not opened). Verdict: do not build anything for Topics; just include the false-only toggles in the opt-in panel.

**Third-party cookies:** Chrome did not remove them; users choose (CHECKED blog). Storage partitioning (storage, service workers, communication APIs) enabled for all from Chrome 115 (REPORTED, developer.chrome.com storage-partitioning). Two ways: (a) native `thirdPartyCookiesAllowed=false` (opt-in; respects Storage Access API and exemptions, per docs CHECKED); (b) DNR cookie removal for all third-party requests: breaks SSO, embedded payments, captchas, logged-in embeds (INFERRED). Prefer (a), keep (b) list-based as now.

**GPC/DNT:** DDG extension sets `Sec-GPC: 1` with DNR `modifyHeaders` `set` (packages/ddg2dnr/lib/gpc.js, CHECKED, Apache-2.0); Ghostery does the same (CHECKED); both also define the JS property; Privacy Badger sends DNT and Sec-GPC (CHECKED). DDG has 61 GPC exceptions (CHECKED), so keep a per-site off switch. Potential clash: Privacy Badger errors if another extension defines the property incompatibly (design notes), so define on `Navigator.prototype` only when absent, as DDG does (CHECKED gpc.js). DNT: obsolete, adds a bit of entropy, skip (INFERRED).

**Referrer trimming:** DNR can `set`/`remove` `Referer` on requests, but only a fixed value, not "origin only" (INFERRED), and a 2023 thread says MV3 DNR cannot change Referer from iframes (REPORTED). Chrome's default is already strict-origin-when-cross-origin (REPORTED, from memory). Low value. DDG's approach is JS only (CHECKED).

**`ping`:** DNR resourceTypes include `ping` and `csp_report` (CHECKED). Blocking third-party `ping` kills beacons and `<a ping>` without the `privacy` permission (mapping of sendBeacon to `ping` INFERRED). Add after a test.

## 5. Local CDN replacement
- Decentraleyes GitHub repo is archived, last push 2019 (CHECKED via API); MPL-2.0.
- LocalCDN (Codeberg): MPL-2.0, Chromium support discontinued: README says it "no longer works" under MV3 (CHECKED, codeberg.org/nobody/LocalCDN); Firefox 86+ only; v2.6.87 dated 2026-09-06.
- Technically possible: DNR `redirect.extensionPath` exists but target must be web accessible (CHECKED). That exposes the extension ID to every site as a detection signal (INFERRED; Chrome's dynamic-URL option for WAR is REPORTED, from memory). AdBrake currently has none (CHECKED).
- Real obstacles: SRI integrity attributes make a swapped file fail unless byte-identical (INFERRED); version-specific URLs; benefit is hiding IP/referrer from CDNs, partly covered by referrer policy; shared-cache gain is gone with partitioned caches (INFERRED).
- Verdict: not worth it now. Revisit only for Google Fonts/jQuery if users ask.

## Unknowns
- Full text of Demir 2024 (per-tool coverage) and Nguyen 2025; arkenfox/Mozilla pages 404 for me.
- Install-warning text and optional-permission support for `privacy`.
- Load-time/size of a 367k-domain DNR ruleset.
- NextDNS list; Chrome native GPC status in 2026; exact Chrome version where Topics is finally stubbed.

## Source URLs
github.com/duckduckgo/autoconsent; registry.npmjs.org/@duckduckgo/autoconsent; github.com/ghostery/ghostery-extension (package.json, src/background/never-consent/gpc.js); github.com/cavi-au/Consent-O-Matic; petsymposium.org/popets/2024/popets-2024-0002.php; github.com/brave/adblock-lists (brave-lists/query-filter.json, debounce.json, clean-urls.json); github.com/duckduckgo/privacy-configuration (features/*.json); github.com/duckduckgo/content-scope-scripts (injected/src/features); github.com/duckduckgo/duckduckgo-privacy-extension (packages/ddg2dnr/lib/gpc.js); github.com/ClearURLs/Rules; github.com/AdguardTeam/AdguardFilters (TrackParamFilter); github.com/AdguardTeam/cname-trackers; developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest and /api/privacy; privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies; privacysandbox.google.com/protections/bounce-tracking-mitigations; developer.chrome.com/docs/privacy-sandbox/storage-partitioning; groups.google.com/a/chromium.org/g/blink-dev/c/_R85yctz4Rs; github.com/brave/brave-browser/wiki/Fingerprinting-Protections; jshelter.org; arxiv.org/abs/2204.01392; sysnet.ucsd.edu/~voelker/pubs/canvas-imc25.pdf; doi.org/10.1145/3696410.3714713; arxiv.org/abs/2406.07647; arxiv.org/abs/1905.01051; coveryourtracks.eff.org/about; codeberg.org/nobody/LocalCDN; theregister.com/2022/09/21/avast_buys_i_dont_care_about_cookies_addon/
