#!/usr/bin/env python3
"""Concatenate content-script files into one bundle per world.

Why: Chrome injected each shared file (config.js, settings.js, ...) only once per page when it
appeared in both the MAIN and ISOLATED content-script lists, so one world lost its namespace
("stats.js needs config.js first"). One self-contained file per world avoids that.

Run after editing anything in src/:  python3 tools/build.py
Check only (writes nothing; exit 1 if build/*.js are missing or out of date):
                                     python3 tools/build.py --check
tests/run.sh runs the write mode first, so the jsc tests always see current bundles.

Also builds build/scriptlets-main.js (MAIN world, registered by src/background/general.js for the
hosts of rules/scriptlets.json only): src/scriptlets/lib.js + src/scriptlets/runner.js + the
rules embedded as JSON, inside one function scope. The rules are checked first (hosts, scriptlet
names known to lib.js, string arguments); a bad rule fails the build.

Also writes dist/ad-shield.user.js (write mode only; dist/ is not in git, so --check does not
compare it): one userscript for Safari's Userscripts app (docs/IOS.md) with the YouTube scriptlets,
rules/cosmetic/youtube.css and the Twitch files of build/main-world.js, chosen by location.hostname.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLES = {
    "build/main-world.js": [
        "src/config.js", "src/shared/settings.js", "src/shared/logger.js", "src/shared/frame.js",
        "src/core/m3u8.js", "src/core/gql.js", "src/core/processor.js", "src/worker/worker-main.js",
        "src/core/worker-source.js", "src/page/health.js", "src/page/page.js",
    ],
    "build/isolated-world.js": [
        "src/config.js", "src/shared/settings.js", "src/shared/blocking.js", "src/shared/logger.js",
        "src/shared/frame.js", "src/shared/stats.js", "src/content/cosmetic.js", "src/content/bridge.js",
    ],
}

SCRIPTLET_BUNDLE = "build/scriptlets-main.js"
SCRIPTLET_SOURCES = ["src/scriptlets/lib.js", "src/scriptlets/runner.js"]
SCRIPTLET_RULES = "rules/scriptlets.json"
USERSCRIPT = "dist/ad-shield.user.js"
YOUTUBE_CSS = "rules/cosmetic/youtube.css"
BLOCKING_JS = "src/shared/blocking.js"
MAIN_WORLD = "build/main-world.js"
# Optional tip link (e.g. https://revolut.me/yourname), one line. Missing or empty file = no tip text.
DONATE_FILE = "docs/donate.txt"
DONATE_RE = re.compile(r"^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~%/?=&+-]*)?$")
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def scriptlet_names(lib_src):
    """Names in the `scriptlets: { 'name': fn, ... }` table of src/scriptlets/lib.js."""
    m = re.search(r"scriptlets: \{(.*?)\n    \}", lib_src, re.S)
    return set(re.findall(r"'([a-z][a-zA-Z-]*)':", m.group(1))) if m else set()


def check_scriptlet_rules(table, known):
    """Problems with rules/scriptlets.json (empty list = fine)."""
    errs = []
    if not isinstance(table, dict) or table.get("version") != 1 or not isinstance(table.get("rules"), list):
        return ["must be an object with version 1 and a rules list"]
    ids = set()
    for i, rule in enumerate(table["rules"]):
        where = "rule %d" % i
        if not isinstance(rule, dict) or set(rule) - {"id", "about", "hosts", "scriptlets"}:
            errs.append("%s: only id, about, hosts, scriptlets allowed" % where)
            continue
        rid = rule.get("id")
        if not isinstance(rid, str) or not rid or rid in ids:
            errs.append("%s: id missing or duplicate" % where)
        ids.add(rid)
        hosts = rule.get("hosts")
        if not isinstance(hosts, list) or not hosts:
            errs.append("%s: hosts must be a non-empty list" % where)
        else:
            for h in hosts:
                if not isinstance(h, str) or not HOST_RE.match(h):
                    errs.append("%s: bad host %r (lowercase, at least two labels, no scheme or wildcard)" % (where, h))
        sl = rule.get("scriptlets")
        if not isinstance(sl, list) or not sl:
            errs.append("%s: scriptlets must be a non-empty list" % where)
            continue
        for s in sl:
            if not isinstance(s, list) or not s or not all(isinstance(x, str) for x in s):
                errs.append("%s: each scriptlet is a list of strings, got %r" % (where, s))
            elif s[0] not in known:
                errs.append("%s: unknown scriptlet %r" % (where, s[0]))
    return errs


def scriptlet_table():
    """rules/scriptlets.json, checked; a bad rule raises ValueError."""
    table = json.loads(read(SCRIPTLET_RULES))
    errs = check_scriptlet_rules(table, scriptlet_names(read(SCRIPTLET_SOURCES[0])))
    if errs:
        raise ValueError("%s: %s" % (SCRIPTLET_RULES, "; ".join(errs)))
    return table


def scriptlet_code(table):
    """(lib.js + runner.js source text, the slim rules as a JSON literal)."""
    slim = {"rules": [{"hosts": r["hosts"], "scriptlets": r["scriptlets"]} for r in table["rules"]]}
    code = "".join("\n// ---- %s ----\n%s\n" % (f, read(f)) for f in SCRIPTLET_SOURCES)
    return code, json.dumps(slim, separators=(",", ":"))


def render_scriptlets():
    code, data = scriptlet_code(scriptlet_table())
    return "".join([
        "// GENERATED by tools/build.py from %s and %s - do not edit.\n" % (", ".join(SCRIPTLET_SOURCES), SCRIPTLET_RULES),
        "(function () {\n", code,
        "\ntry {\n  asScriptletRunner.run(window, asScriptlets, %s);\n} catch (e) { /* never break the page */ }\n})();\n" % data])


def js_string(text):
    """A JS string literal for text that is also safe inside an HTML <script> element."""
    return json.dumps(text).replace("</", "<\\/").replace("<!--", "<\\!--")


def youtube_css_hosts():
    """YOUTUBE_CSS_HOSTS of src/shared/blocking.js (where the extension registers youtube.css)."""
    m = re.search(r"var YOUTUBE_CSS_HOSTS = \[([^\]]*)\]", read(BLOCKING_JS))
    hosts = re.findall(r"'([^']+)'", m.group(1)) if m else []
    if not hosts or not all(HOST_RE.match(h) for h in hosts):
        raise ValueError("%s: YOUTUBE_CSS_HOSTS not found or malformed" % BLOCKING_JS)
    return hosts


def twitch_hosts():
    """(hosts, exclude patterns) of the manifest content script that loads build/main-world.js."""
    manifest = json.loads(read("manifest.json"))
    for cs in manifest.get("content_scripts", []):
        if MAIN_WORLD in cs.get("js", []):
            hosts = []
            for pat in cs["matches"]:
                m = re.match(r"^(?:\*|https?)://(?:\*\.)?([a-z0-9.-]+)/\*$", pat)
                if not m or not HOST_RE.match(m.group(1)):
                    raise ValueError("manifest.json: unexpected match pattern %r for %s" % (pat, MAIN_WORLD))
                if m.group(1) not in hosts:
                    hosts.append(m.group(1))
            return hosts, list(cs.get("exclude_matches", []))
    raise ValueError("manifest.json: no content script loads %s" % MAIN_WORLD)


def exclude_hosts(patterns):
    """Exact hosts of exclude patterns like https://clips.twitch.tv/* (for the runtime check)."""
    out = []
    for pat in patterns:
        m = re.match(r"^(?:\*|https?)://([a-z0-9.-]+)/\*$", pat)
        if not m:
            raise ValueError("manifest.json: unsupported exclude pattern %r" % pat)
        out.append(m.group(1))
    return out


USERSCRIPT_RUNTIME = r"""
  var MARK = '__adShieldUserscript__';
  try {
    if (!win || win[MARK]) return;
    Object.defineProperty(win, MARK, { value: true, enumerable: false });
  } catch (e) { return; }

  var host = '';
  try { host = win.location.hostname || win.document.domain || ''; } catch (e) { host = ''; }
  host = String(host).toLowerCase().replace(/\.$/, '');
  // A listed host covers itself and its subdomains, like src/scriptlets/runner.js.
  function covered(list) {
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (host === h || (host.length > h.length && host.slice(-(h.length + 1)) === '.' + h)) return true;
    }
    return false;
  }

  if (covered(SCRIPTLET_HOSTS)) { try { youtubeScriptlets(); } catch (e) { /* never break the page */ } }
  if (covered(CSS_HOSTS)) { try { youtubeCss(); } catch (e) { /* never break the page */ } }
  if (covered(TWITCH_HOSTS) && TWITCH_SKIP.indexOf(host) === -1) {
    try { twitch(); } catch (e) { /* never break the page */ }
  }

  // rules/cosmetic/youtube.css as one <style>. At document-start <head> may not exist yet, so it
  // goes on <html> then; it is put back when YouTube's single-page navigation drops it.
  function youtubeCss() {
    var doc = win.document;
    if (!doc) return;
    var style = null;
    function ensure() {
      try {
        if (style && style.parentNode && style.isConnected !== false) return;
        var parent = doc.head || doc.documentElement;
        if (!parent) return;
        if (!style) {
          style = doc.createElement('style');
          style.id = 'ad-shield-css';
          style.textContent = YOUTUBE_CSS;
        }
        parent.appendChild(style);
      } catch (e) { /* never break the page */ }
    }
    ensure();
    if (!style && typeof win.MutationObserver === 'function') {
      var mo = new win.MutationObserver(function () {
        if (doc.documentElement) { mo.disconnect(); ensure(); }
      });
      mo.observe(doc, { childList: true });
    }
    ['DOMContentLoaded', 'readystatechange', 'yt-navigate-finish', 'yt-page-data-updated'].forEach(function (t) {
      doc.addEventListener(t, ensure);
    });
  }
"""


def donate_url(root=None):
    """The optional tip link from docs/donate.txt ('' when absent or empty). Only a plain https URL
    is accepted, so nothing else (bank numbers, script text) can end up in the builds."""
    path = os.path.join(root or ROOT, DONATE_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [l.strip() for l in fh.read().splitlines() if l.strip() and not l.strip().startswith("#")]
    except OSError:
        return ""
    if not lines:
        return ""
    url = lines[0]
    if len(lines) > 1 or len(url) > 200 or not DONATE_RE.match(url):
        raise ValueError("%s: must hold one https:// link (or nothing), got %r" % (DONATE_FILE, url[:80]))
    return url


def render_userscript():
    """dist/ad-shield.user.js: YouTube scriptlets + CSS and the Twitch MAIN-world bundle in one
    userscript for Safari's Userscripts app (page world, document-start, no chrome.*)."""
    version = json.loads(read("manifest.json"))["version"]
    table = scriptlet_table()
    sl_code, sl_data = scriptlet_code(table)
    sl_hosts = []
    for r in table["rules"]:
        for h in r["hosts"]:
            if h not in sl_hosts:
                sl_hosts.append(h)
    css_hosts = youtube_css_hosts()
    tw_hosts, tw_exclude = twitch_hosts()
    all_hosts = []
    for h in sl_hosts + css_hosts + tw_hosts:
        if h not in all_hosts:
            all_hosts.append(h)

    def field(key, value):
        return "// @%-13s %s\n" % (key, value)

    head = ["// ==UserScript==\n",
            field("name", "Ad Shield (YouTube + Twitch)"),
            field("namespace", "ad-shield"),
            field("version", version),
            field("description", "Blocks YouTube and Twitch video ads. Ad Shield's own MIT code, for Safari's Userscripts app."),
            field("license", "MIT")]
    for h in all_hosts:
        head.append(field("match", "*://%s/*" % h))
        head.append(field("match", "*://*.%s/*" % h))
    for pat in tw_exclude:
        head.append(field("exclude-match", pat))
    head += [field("run-at", "document-start"), field("inject-into", "page"), field("grant", "none"),
             "// ==/UserScript==\n"]

    body = ["// GENERATED by tools/build.py from src/, %s and %s - do not edit. MIT licence.\n" % (SCRIPTLET_RULES, YOUTUBE_CSS),
            "// Runs in the page's own world; no chrome.* exists there, so settings stay at their defaults.\n",
            "// Install and limits: docs/IOS.md\n",
            ("// Like Ad Shield? An optional tip: %s\n" % donate_url()) if donate_url() else "",
            "(function (win) {\n",
            "  var SCRIPTLET_HOSTS = %s;\n" % json.dumps(sl_hosts),
            "  var CSS_HOSTS = %s;\n" % json.dumps(css_hosts),
            "  var TWITCH_HOSTS = %s;\n" % json.dumps(tw_hosts),
            "  var TWITCH_SKIP = %s;\n" % json.dumps(exclude_hosts(tw_exclude)),
            "  var YOUTUBE_CSS = %s;\n" % js_string(read(YOUTUBE_CSS)),
            USERSCRIPT_RUNTIME,
            "\n// YouTube: same code as build/scriptlets-main.js.\nfunction youtubeScriptlets() {\n",
            sl_code,
            "\nasScriptletRunner.run(win, asScriptlets, %s);\n}\n" % sl_data,
            "\n// Twitch: same files as %s; they share root.__TAS__ and page.js removes it.\nfunction twitch() {\n" % MAIN_WORLD]
    for f in BUNDLES[MAIN_WORLD]:
        body.append("\n// ---- %s ----\n%s\n;\n" % (f, read(f)))
    body.append("}\n})(window);\n")
    return "".join(head + body)


def render(files):
    parts = ["// GENERATED by tools/build.py - do not edit; edit the files in src/ instead.\n"]
    for f in files:
        with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
            parts.append("\n// ---- %s ----\n%s\n;\n" % (f, fh.read()))
    return "".join(parts)


def main(argv):
    check = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print("usage: python3 tools/build.py [--check]")
        return 2
    stale = []
    outputs = [(out, render(files)) for out, files in BUNDLES.items()]
    try:
        outputs.append((SCRIPTLET_BUNDLE, render_scriptlets()))
        # dist/ is not in git, so --check renders the userscript (catching errors) but never
        # compares it; the write mode always writes it.
        userscript = render_userscript()
    except (ValueError, OSError) as e:
        print("ERROR", e)
        return 1
    if not check:
        outputs.append((USERSCRIPT, userscript))
    for out, text in outputs:
        path = os.path.join(ROOT, out)
        if check:
            try:
                with open(path, encoding="utf-8") as fh:
                    current = fh.read()
            except OSError:
                current = None
            if current != text:
                stale.append(out)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote", out, len(text), "bytes")
    if check:
        if stale:
            print("out of date (run python3 tools/build.py):", ", ".join(stale))
            return 1
        print("bundles up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
