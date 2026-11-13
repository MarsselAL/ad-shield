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
"""
import ast
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED_PERMISSIONS = {"storage", "scripting", "declarativeNetRequest"}
ALLOWED_HOSTS = {"*://*.twitch.tv/*", "*://*.ttvnw.net/*"}

errors = []
checks = 0


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
    check(m.get("version") == "1.0.0", "version must be 1.0.0")
    check(m.get("minimum_chrome_version") == "120", "minimum_chrome_version must be 120")
    check("twitch" not in json.dumps(m.get("icons", {})).lower(), "icons must not be Twitch-branded files")

    perms = set(m.get("permissions", []))
    check(perms <= ALLOWED_PERMISSIONS, "permissions not allowed: %s" % sorted(perms - ALLOWED_PERMISSIONS))
    check(perms == ALLOWED_PERMISSIONS, "expected exactly %s" % sorted(ALLOWED_PERMISSIONS))
    hosts = set(m.get("host_permissions", []))
    check(hosts <= ALLOWED_HOSTS, "host_permissions not allowed: %s" % sorted(hosts - ALLOWED_HOSTS))
    check("*://*.twitch.tv/*" in hosts, "host_permissions must include *://*.twitch.tv/*")
    check("optional_permissions" not in m and "optional_host_permissions" not in m, "no optional permissions expected")
    cs = m.get("content_scripts", [])
    check(any(c.get("world") == "MAIN" and c.get("run_at") == "document_start" for c in cs), "MAIN-world document_start content script required")
    for c in cs:
        for f in c.get("js", []):
            check(os.path.isfile(os.path.join(ROOT, f)) if "ROOT" in globals() else True, "content script file missing: " + f)
    check("web_accessible_resources" not in m, "no web_accessible_resources expected")

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
    bundles = load_bundles()
    check(sorted(bundles) == ["build/isolated-world.js", "build/main-world.js"],
          "tools/build.py BUNDLES must define build/main-world.js and build/isolated-world.js")
    for name, files in sorted(bundles.items()):
        check(len(files) > 0, "%s file list is empty" % name)
        check(files[:1] == ["src/config.js"], "%s must start with src/config.js" % name)
        for f in files:
            exists(f, "%s entry" % name)
    main_files = bundles.get("build/main-world.js", [])
    check("src/page/page.js" in main_files and "src/page/recovery.js" in main_files
          and main_files.index("src/page/recovery.js") < main_files.index("src/page/page.js"),
          "page.js must come after recovery.js in the main-world bundle")
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
    check(sorted(ids) == ["client_ads", "trackers"], "rulesets must be client_ads and trackers, got %s" % ids)
    for r in rr:
        if r.get("id") == "trackers":
            check(r.get("enabled") is False, "trackers ruleset must be disabled by default")
        rules = load_json(r.get("path", ""))
        if rules is None:
            continue
        check(isinstance(rules, list) and rules, "%s must be a non-empty list" % r.get("path"))
        rule_ids = [x.get("id") for x in rules]
        check(len(rule_ids) == len(set(rule_ids)), "%s: duplicate rule ids %s" % (r.get("path"), rule_ids))
        for x in rules:
            check(isinstance(x.get("id"), int) and x["id"] >= 1, "%s: bad rule id %r" % (r.get("path"), x.get("id")))
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
    return report()


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
