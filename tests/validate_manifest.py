#!/usr/bin/env python3
"""Offline checks for manifest.json, the DNR rulesets and the files they reference.

Run with:  python3 -I tests/validate_manifest.py      (exit code 0 = OK)
Checks:
  - manifest.json and every ruleset parse as JSON
  - every file referenced by the manifest, the HTML pages, the background importScripts and the
    content-script bundle lists in tools/build.py exists
  - the content scripts are the build/ bundles; the service worker no longer registers scripts
  - permissions / host permissions are limited to the allowed list
  - rule ids are unique within each ruleset, rules have the required shape
  - the Twitch rulesets keep their narrow twitch.tv-only shape (client_ads: allow rules only,
    above every list rule, so Twitch's own ad requests never fail on live streams; trackers:
    block rules only); every rule
    of the generated general rulesets passes tests/dnr_schema.py; the curated rulesets
    (ads_curated, privacy_curated) exist, are enabled, in order, and have exactly the one-rule
    third-party block shape; static rule / regex / ruleset limits hold; the general content-script files exist; vendored autoconsent is unmodified
  - the hand-written gpc ruleset only sets Sec-GPC: 1 on page loads (dnr_schema.gpc_ruleset_errors);
  - the surrogate rulesets only redirect script URLs to existing src/surrogates/*.js files, which are
    exactly the web_accessible_resources and make no requests;
  - the unwrap ruleset only redirects page loads to https://<host> (dnr_schema.unwrap_ruleset_errors);
  - the hand-written youtube ruleset blocks only its two paths; other redirect rules exist only in
    removeparam.json and have its exact shape (tests/dnr_schema.removeparam_ruleset_errors); the scriptlet bundle exists and the
    scriptlet sources contain no URLs
"""
import ast
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dnr_schema  # noqa: E402

# alarms: weekly filter-list update; unlimitedStorage: the updated lists' rules and site data
# (~5 MB) next to the 10 MB default quota.
ALLOWED_PERMISSIONS = {"storage", "scripting", "declarativeNetRequest", "declarativeNetRequestFeedback", "alarms",
                       "unlimitedStorage"}
ALLOWED_HOSTS = {"*://*.twitch.tv/*", "*://*.ttvnw.net/*", "<all_urls>"}
TWITCH_RULESETS = ["client_ads", "trackers"]
GENERATED_RULESET_RE = dnr_schema.GENERATED_RULESET_RE

errors = []
checks = 0



# rules/youtube.json besides its two block rules (exact; see the youtube check below).
YOUTUBE_PP = "oAEBogYBLg"
YOUTUBE_PP_RULES = [
    {"id": 3, "priority": 1,
     "action": {"type": "redirect", "redirect": {"transform": {"queryTransform": {"addOrReplaceParams": [{"key": "pp", "value": YOUTUBE_PP}]}}}},
     "condition": {"urlFilter": "|https://www.youtube.com/watch?", "resourceTypes": ["main_frame"]}},
    {"id": 500001, "priority": 2,  # allow rules use the allow id range (tools/filterlist.py ALLOW_ID_BASE)
     "action": {"type": "allow"},
     "condition": {"urlFilter": "|https://www.youtube.com/watch?*pp=" + YOUTUBE_PP, "resourceTypes": ["main_frame"]}},
]

def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        errors.append(msg)


def exists(rel, what):
    path = os.path.normpath(os.path.join(ROOT, rel.lstrip("/")))
    check(path.startswith(ROOT) and os.path.isfile(path), "%s missing: %s" % (what, rel))
    return path


def load_json(rel):
    path = exists(rel, "JSON file")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        errors.append("%s does not parse: %s" % (rel, e))
        return None


def load_bundles():
    """Read the BUNDLES literal from tools/build.py without executing the script."""
    path = exists("tools/build.py", "build script")
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except Exception as e:  # noqa: BLE001
        errors.append("tools/build.py does not parse: %s" % e)
        return {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "BUNDLES" for t in node.targets):
            try:
                return ast.literal_eval(node.value)
            except ValueError as e:
                errors.append("tools/build.py BUNDLES is not a literal: %s" % e)
                return {}
    errors.append("tools/build.py has no BUNDLES")
    return {}


def main():
    m = load_json("manifest.json")
    if m is None:
        return report()

    check(m.get("manifest_version") == 3, "manifest_version must be 3")
    check(m.get("version") == "2.0.3", "version must be 2.0.3")
    check(m.get("minimum_chrome_version") == "120", "minimum_chrome_version must be 120")
    check(m.get("name") == "AdBrake \u2013 Ad Blocker", "name must be AdBrake \u2013 Ad Blocker")
    check("video-ad" in m.get("description", "").lower(), "description must still mention video-ad blocking")
    check(not any(b in m.get("description", "").lower() for b in ("twitch", "youtube")),
          "description must not name third-party brands (keyword-spam rejection, docs/store/review-risks.md)")
    check(len(m.get("description", "")) <= 132, "description must be at most 132 characters")
    check("<all_urls>" in m.get("host_permissions", []), "host_permissions must include <all_urls> (modifyHeaders, cosmetic CSS)")
    check("twitch" not in json.dumps(m.get("icons", {})).lower(), "icons must not be Twitch-branded files")

    perms = set(m.get("permissions", []))
    check(perms <= ALLOWED_PERMISSIONS, "permissions not allowed: %s" % sorted(perms - ALLOWED_PERMISSIONS))
    check(perms == ALLOWED_PERMISSIONS, "expected exactly %s" % sorted(ALLOWED_PERMISSIONS))
    hosts = set(m.get("host_permissions", []))
    check(hosts <= ALLOWED_HOSTS, "host_permissions not allowed: %s" % sorted(hosts - ALLOWED_HOSTS))
    check(hosts == {"<all_urls>"}, "host_permissions must be exactly <all_urls> (it already covers twitch.tv)")
    check("optional_permissions" not in m and "optional_host_permissions" not in m, "no optional permissions expected")
    cs = m.get("content_scripts", [])
    check(any(c.get("world") == "MAIN" and c.get("run_at") == "document_start" for c in cs), "MAIN-world document_start content script required")
    for c in cs:
        for f in c.get("js", []):
            check(os.path.isfile(os.path.join(ROOT, f)) if "ROOT" in globals() else True, "content script file missing: " + f)
    # Only the surrogate scripts are web accessible (DNR extensionPath redirects need it); they
    # are checked against the surrogate rulesets below. No use_dynamic_url: Chrome's web-accessible
    # check then requires the per-session GUID host, but DNR redirects to the static-ID URL.
    war = m.get("web_accessible_resources")
    check(isinstance(war, list) and len(war) == 1 and isinstance(war[0], dict)
          and set(war[0]) == {"resources", "matches"} and war[0].get("matches") == ["<all_urls>"],
          "web_accessible_resources must be one entry {resources, matches: [<all_urls>]}")
    war_resources = war[0].get("resources", []) if isinstance(war, list) and war and isinstance(war[0], dict) else []
    surrogate_paths = set()

    # Referenced files
    bg = m.get("background", {}).get("service_worker")
    check(bool(bg), "background.service_worker missing")
    if bg:
        bg_path = exists(bg, "service worker")
        if os.path.isfile(bg_path):
            src = open(bg_path, encoding="utf-8").read()
            for imp in re.findall(r"importScripts\(([^)]*)\)", src):
                for f in re.findall(r"'([^']+)'", imp):
                    exists(f, "importScripts file")
            check("registerContentScripts(" not in src.replace("unregisterContentScripts(", ""),
                  "service worker must not register content scripts dynamically (they are in manifest.json)")
            check("/src/background/general.js" in src and "/src/shared/blocking.js" in src,
                  "service worker must load src/shared/blocking.js and src/background/general.js")
            order = ["/src/shared/blocking.js", "/src/shared/userfilters.js", "/src/shared/filterlist.js", "/src/shared/lists.js",
                     "/src/background/general.js", "/src/background/updater.js"]
            pos = [src.find(f) for f in order]
            check(all(p >= 0 for p in pos) and pos == sorted(pos),
                  "service worker must load %s in this order" % ", ".join(order))
    gen = os.path.join(ROOT, "src", "background", "general.js")
    if os.path.isfile(gen):
        gsrc = open(gen, encoding="utf-8").read()
        for legacy in ("tas-page-main", "tas-bridge-isolated"):
            check(legacy not in gsrc, "general.js must not touch the Twitch script id " + legacy)
    upd = os.path.join(ROOT, "src", "shared", "lists.js")
    if os.path.isfile(upd):
        urls = sorted(set(re.findall(r"https?://[^'\"\s]+", open(upd, encoding="utf-8").read())))
        check(urls == ["https://easylist.to/easylist/easylist.txt", "https://easylist.to/easylist/easyprivacy.txt",
                       "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt"],
              "src/shared/lists.js may only name the three list URLs, got %s" % urls)
    for bg_file in ("general.js", "updater.js", "service-worker.js"):
        bp = os.path.join(ROOT, "src", "background", bg_file)
        if os.path.isfile(bp):
            check(not re.search(r"https?://[A-Za-z0-9]", open(bp, encoding="utf-8").read().split("*/", 1)[1]),
                  "src/background/%s must not contain URLs in code (fetches only via lists.js)" % bg_file)
    blk = os.path.join(ROOT, "src", "shared", "blocking.js")
    if os.path.isfile(blk):
        bsrc = open(blk, encoding="utf-8").read()
        for f in re.findall(r"'((?:rules|src|vendor)/[^']+\.(?:js|css|json))'", bsrc):
            exists(f, "registered content-script file")
        check("ALLOW_ID_BASE = 500000" in bsrc, "blocking.js ALLOW_ID_BASE must match tools/filterlist.py")
        # Our MAIN-world scriptlets: generated bundle registered by blocking.contentScriptPlan.
        check("'build/scriptlets-main.js'" in bsrc and "world: 'MAIN'" in bsrc, "blocking.js must register build/scriptlets-main.js in the MAIN world")
        exists("build/scriptlets-main.js", "scriptlet bundle (run python3 tools/build.py)")
    # Element picker: injected by the popup on click only (never registered), no network use.
    pop = os.path.join(ROOT, "src", "popup", "popup.js")
    if os.path.isfile(pop):
        picker_files = re.findall(r"files: \[([^\]]*)\]", open(pop, encoding="utf-8").read())
        names = re.findall(r"'([^']+)'", picker_files[0]) if picker_files else []
        check(names == ["src/shared/selector.js", "src/content/picker.js"],
              "popup.js must inject exactly src/shared/selector.js then src/content/picker.js, got %s" % names)
        for f in names:
            exists(f, "element picker file")
    for f in ("src/content/picker.js", "src/shared/selector.js", "src/shared/userfilters.js"):
        p = exists(f, "element picker / My filters source")
        if os.path.isfile(p):
            check(not re.search(r"https?://[A-Za-z0-9]", open(p, encoding="utf-8").read()), "%s must not contain URLs" % f)
    sl_rules = load_json("rules/scriptlets.json")
    check(isinstance(sl_rules, dict) and sl_rules.get("version") == 1, "rules/scriptlets.json must have version 1")
    for f in ("src/scriptlets/lib.js", "src/scriptlets/runner.js"):
        p = exists(f, "scriptlet source")
        if os.path.isfile(p):
            check(not re.search(r"https?://[A-Za-z0-9]", open(p, encoding="utf-8").read()),
                  "%s must not contain URLs (scriptlets never fetch anything themselves)" % f)
    fl = os.path.join(ROOT, "tools", "filterlist.py")
    if os.path.isfile(fl):
        check("ALLOW_ID_BASE = 500000" in open(fl, encoding="utf-8").read(), "tools/filterlist.py ALLOW_ID_BASE changed")
    vjson = load_json("vendor/autoconsent/VERSION.json")
    if vjson:
        check(vjson.get("licence") == "MPL-2.0" and vjson.get("modified") is False, "autoconsent must be MPL-2.0 and unmodified")
        for name, digest in sorted(vjson.get("sha256", {}).items()):
            vp = exists("vendor/autoconsent/" + name, "vendored autoconsent file")
            if os.path.isfile(vp):
                check(hashlib.sha256(open(vp, "rb").read()).hexdigest() == digest, "vendor/autoconsent/%s was modified" % name)
    for f in ("NOTICE.md", "rules/NOTICE.md"):
        exists(f, "licence notice")
    bundles = load_bundles()
    check(sorted(bundles) == ["build/isolated-world.js", "build/main-world.js"],
          "tools/build.py BUNDLES must define build/main-world.js and build/isolated-world.js")
    for name, files in sorted(bundles.items()):
        check(len(files) > 0, "%s file list is empty" % name)
        check(files[:1] == ["src/config.js"], "%s must start with src/config.js" % name)
        for f in files:
            exists(f, "%s entry" % name)
    main_files = bundles.get("build/main-world.js", [])
    check("src/page/page.js" in main_files and "src/page/health.js" in main_files
          and main_files.index("src/page/health.js") < main_files.index("src/page/page.js"),
          "page.js must come after health.js in the main-world bundle")
    check("src/page/recovery.js" not in main_files, "recovery.js was removed in 2.0")
    check(main_files[-1:] == ["src/page/page.js"], "page.js must be the last file of the main-world bundle")
    worlds = {c.get("world", "ISOLATED"): c.get("js", []) for c in cs}
    check(worlds.get("MAIN") == ["build/main-world.js"], "MAIN-world content script must be build/main-world.js")
    check(worlds.get("ISOLATED") == ["build/isolated-world.js"], "ISOLATED-world content script must be build/isolated-world.js")
    lt = os.path.join(ROOT, "tools", "live_test.py")
    if os.path.isfile(lt):
        lt_src = open(lt, encoding="utf-8").read()
        lt_main = re.search(r"MAIN_FILES = \[([^\]]*)\]", lt_src)
        check(bool(lt_main) and re.findall(r'"([^"]+)"', lt_main.group(1)) == main_files,
              "tools/live_test.py MAIN_FILES must equal the main-world bundle list in tools/build.py")
    action = m.get("action", {})
    for size, icon in sorted(action.get("default_icon", {}).items()) + sorted(m.get("icons", {}).items()):
        p = exists(icon, "icon %s" % size)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                head = f.read(24)
            check(head[:8] == b"\x89PNG\r\n\x1a\n", "%s is not a PNG" % icon)
            if len(head) >= 24:
                w = int.from_bytes(head[16:20], "big")
                check(str(w) == str(size), "%s is %dpx, expected %s" % (icon, w, size))
    pages = [action.get("default_popup"), m.get("options_ui", {}).get("page")]
    for page in pages:
        check(bool(page), "popup/options page missing in manifest")
        if not page:
            continue
        p = exists(page, "HTML page")
        if os.path.isfile(p):
            html = open(p, encoding="utf-8").read()
            check("<script>" not in html and not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), "%s has inline script (MV3 CSP)" % page)
            check(not re.search(r"(src|href)=\"https?:", html), "%s loads remote resources" % page)
            for ref in re.findall(r"(?:src|href)=\"([^\"#:]+)\"", html):
                exists(os.path.join(os.path.dirname(page), ref), "%s reference" % page)

    # Rulesets
    rr = m.get("declarative_net_request", {}).get("rule_resources", [])
    ids = [r.get("id") for r in rr]
    check(ids[:2] == TWITCH_RULESETS, "first rulesets must be client_ads and trackers, got %s" % ids[:2])
    check(len(ids) == len(set(ids)), "duplicate ruleset ids")
    general = [i for i in ids if i not in TWITCH_RULESETS]
    check(all(GENERATED_RULESET_RE.match(i) for i in general), "unexpected ruleset ids %s" % general)
    for want in ("ads_1", "privacy_1", "cookies_1", "cookie_strip", dnr_schema.REMOVEPARAM_RULESET,
                 dnr_schema.GPC_RULESET, dnr_schema.UNWRAP_RULESET) + dnr_schema.CURATED_RULESETS:
        check(want in general, "ruleset %s missing" % want)
    if all(GENERATED_RULESET_RE.match(i) for i in general):
        check(general == sorted(general, key=dnr_schema.general_order_key),
              "general rulesets out of order (ads_N, ads_curated, privacy_N, privacy_curated, cookies_N, cookie_strip): %s" % general)
    check(len(ids) <= dnr_schema.MAX_NUMBER_OF_STATIC_RULESETS, "too many rulesets")
    check(sum(1 for r in rr if r.get("enabled")) <= dnr_schema.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS, "too many enabled rulesets")
    enabled_rules = 0
    regexes = 0
    for r in rr:
        if r.get("id") == "trackers":
            check(r.get("enabled") is False, "trackers ruleset must be disabled by default")
        check(r.get("path") == "rules/%s.json" % r.get("id"), "ruleset %s path must be rules/<id>.json" % r.get("id"))
        rules = load_json(r.get("path", ""))
        if rules is None:
            continue
        check(isinstance(rules, list) and rules, "%s must be a non-empty list" % r.get("path"))
        regexes += dnr_schema.regex_count(rules)
        if r.get("enabled"):
            enabled_rules += len(rules)
        if r.get("id") == "youtube":
            # Hand-written: only the two safe YouTube ad paths (docs/research-v2.md B.5); never
            # /api/stats/ or get_drm_license (both break playback / "free with ads" films).
            check(r.get("enabled") is True, "youtube ruleset must be enabled by default")
            blocks = [x for x in rules if isinstance(x, dict) and x.get("action", {}).get("type") == "block"]
            flt = sorted(x.get("condition", {}).get("urlFilter", "") for x in blocks)
            check(flt == ["||youtube.com/pagead/", "||youtube.com/youtubei/v1/player/ad_break"],
                  "rules/youtube.json must block exactly /pagead/ and /youtubei/v1/player/ad_break, got %s" % flt)
            check(all(x.get("action") == {"type": "block"} and set(x.get("condition", {})) == {"urlFilter"} for x in blocks),
                  "rules/youtube.json: plain block rules only (no resourceTypes: main_frame is never blocked)")
            # Plus the watch-page player params (uBO "oaeb", docs/DESIGN-v2.md YouTube): a direct
            # www.youtube.com/watch load gets pp=oAEBogYBLg, and an allow rule one step above it
            # for the URL that already has it, so the redirect cannot loop.
            rest = sorted((json.dumps(x, sort_keys=True) for x in rules if isinstance(x, dict) and x not in blocks))
            want = sorted(json.dumps(x, sort_keys=True) for x in YOUTUBE_PP_RULES)
            check(rest == want, "rules/youtube.json: besides the two blocks exactly the pp redirect + allow rules %s, got %s" % (want, rest))
        if r.get("id") == dnr_schema.REMOVEPARAM_RULESET:
            check(r.get("enabled") is True, "removeparam ruleset must be enabled by default")
            for msg in dnr_schema.removeparam_ruleset_errors(rules, r.get("path")):
                errors.append(msg)
        elif r.get("id") == dnr_schema.UNWRAP_RULESET:
            check(r.get("enabled") is True, "unwrap ruleset must be enabled by default")
            for msg in dnr_schema.unwrap_ruleset_errors(rules, r.get("path")):
                errors.append(msg)
        elif r.get("id") in dnr_schema.SURROGATE_RULESETS:
            check(r.get("enabled") is True, "%s must be enabled by default" % r.get("id"))
            for msg in dnr_schema.surrogate_ruleset_errors(rules, r.get("path"), lambda p: os.path.isfile(os.path.join(ROOT, p.lstrip("/")))):
                errors.append(msg)
            surrogate_paths.update(x["action"]["redirect"]["extensionPath"].lstrip("/") for x in rules
                                   if isinstance(x, dict) and "extensionPath" in x.get("action", {}).get("redirect", {}))
        else:
            check(r.get("id") == "youtube" or not any(isinstance(x, dict) and x.get("action", {}).get("type") == "redirect" for x in rules),
                  "%s: redirect rules are only allowed in rules/removeparam.json, rules/unwrap.json, the surrogate rulesets (and the youtube pp rule)" % r.get("path"))
        if r.get("id") == dnr_schema.GPC_RULESET:
            check(r.get("enabled") is True, "gpc ruleset must be enabled by default")
            for msg in dnr_schema.gpc_ruleset_errors(rules, r.get("path")):
                errors.append(msg)
        if r.get("id") in dnr_schema.CURATED_RULESETS:
            check(r.get("enabled") is True, "%s must be enabled by default" % r.get("id"))
            for msg in dnr_schema.curated_ruleset_errors(rules, r.get("path")):
                errors.append(msg)
        if r.get("id") not in TWITCH_RULESETS:
            for msg in dnr_schema.ruleset_errors(rules, r.get("path")):
                errors.append(msg)
            checks_add(len(rules))
            continue
        rule_ids = [x.get("id") for x in rules]
        check(len(rule_ids) == len(set(rule_ids)), "%s: duplicate rule ids %s" % (r.get("path"), rule_ids))
        for x in rules:
            check(isinstance(x.get("id"), int) and x["id"] >= 1, "%s: bad rule id %r" % (r.get("path"), x.get("id")))
            if r.get("id") == "client_ads":
                # Since 2.0: let Twitch's client-side ad requests through (EasyList blocks
                # edge.ads.twitch.tv); a failed one on a live stream brings up Twitch's ad-block
                # notice. VOD requests are answered in the page (src/page/page.js).
                check(r.get("enabled") is True, "client_ads ruleset must be enabled by default")
                check(x.get("action") == {"type": "allow"}, "%s rule %s: only allow rules expected" % (r.get("path"), x.get("id")))
                check(x["id"] >= 500000, "%s rule %s: allow rules use the allow id range" % (r.get("path"), x.get("id")))
                check(isinstance(x.get("priority"), int) and 4 < x["priority"] < 100,
                      "%s rule %s: priority must be above the list rules (1-4) and below the site allowlist (100)" % (r.get("path"), x.get("id")))
            else:
                check(x.get("action", {}).get("type") == "block", "%s rule %s: only block rules expected" % (r.get("path"), x.get("id")))
            cond = x.get("condition", {})
            check(bool(cond.get("urlFilter") or cond.get("regexFilter")), "%s rule %s: no filter" % (r.get("path"), x.get("id")))
            check(cond.get("initiatorDomains") == ["twitch.tv"], "%s rule %s: must be limited to twitch.tv initiators" % (r.get("path"), x.get("id")))
            check(bool(cond.get("resourceTypes")), "%s rule %s: resourceTypes required" % (r.get("path"), x.get("id")))
            flt = (cond.get("urlFilter") or "") + (cond.get("regexFilter") or "")
            for forbidden in ("gql.twitch.tv", "usher.ttvnw.net", "live-video.net", "spade", "countess"):
                check(forbidden not in flt, "%s rule %s blocks %s (unsafe for playback)" % (r.get("path"), x.get("id"), forbidden))
            if cond.get("regexFilter"):
                try:
                    re.compile(cond["regexFilter"])
                except re.error as e:
                    errors.append("%s rule %s: bad regex %s" % (r.get("path"), x.get("id"), e))
    for sr in dnr_schema.SURROGATE_RULESETS:
        check(sr in ids, "ruleset %s missing" % sr)
    check(war_resources == sorted(surrogate_paths),
          "web_accessible_resources must list exactly the surrogate files the rulesets redirect to (sorted): %s, got %s"
          % (sorted(surrogate_paths), war_resources))
    for f in war_resources:
        p = exists(f, "surrogate script")
        if os.path.isfile(p):
            check(not re.search(r"(fetch|XMLHttpRequest|sendBeacon|importScripts)\s*\(|new\s+(Image|WebSocket)\b", open(p, encoding="utf-8").read()),
                  "%s must not make requests" % f)
    check(enabled_rules <= dnr_schema.GUARANTEED_MINIMUM_STATIC_RULES,
          "enabled static rules %d exceed the guaranteed %d" % (enabled_rules, dnr_schema.GUARANTEED_MINIMUM_STATIC_RULES))
    check(regexes <= dnr_schema.MAX_NUMBER_OF_REGEX_RULES, "%d regex rules (max %d)" % (regexes, dnr_schema.MAX_NUMBER_OF_REGEX_RULES))
    return report()


def checks_add(n):
    global checks
    checks += n


def report():
    if errors:
        for e in errors:
            print("FAIL", e)
        print("validate_manifest: %d problem(s) in %d checks" % (len(errors), checks))
        return 1
    print("validate_manifest: OK (%d checks)" % checks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
