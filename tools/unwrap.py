#!/usr/bin/env python3
"""Link unwrapping: rules/unwrap.txt (our own list) -> rules/unwrap.json.

    python3 -I tools/unwrap.py     check the list (patterns and every test / miss line)
The ruleset is written by tools/build_rules.py (full build and --curated-only), which also keeps
it in manifest.json, so it is rebuilt offline with:  python3 -I tools/build_rules.py --curated-only

Rule shape (Chrome declarativeNetRequest), one rule per entry:
  action    redirect with regexSubstitution (\\1..\\9 = capture groups of regexFilter)
  condition regexFilter (anchored ^https?:// ... $), resourceTypes main_frame only (a page opened
            from a link or typed in; frames and subresources are never touched),
            excludedInitiatorDomains for sites where the entry says links are left alone
  priority  PRIORITY (55): above every list rule (1..4) and removeparam (50), so an AMP page is
            unwrapped first and the real page then loses its tracking parameters; below the
            per-site allowlist rule (100, allowAllRequests), which therefore wins.
Safety checks (the tool refuses the list otherwise): every target starts with https://; a target
that begins with a capture group must take it from a host-name pattern followed by "/", "?", "#"
or the end, so the result is always an https URL on a real host name (no other scheme, no
user@host, no :port); every test line ends where it says after following all rules (at most
MAX_HOPS redirects, so no loops) and every miss line matches no rule.
"""
import json
import os
import re
import sys
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = "rules/unwrap.txt"
OUTPUT = "rules/unwrap.json"
RULESET_ID = "unwrap"
PRIORITY = 55
RESOURCE_TYPES = ["main_frame"]
MAX_HOPS = 3
# Capture group 1 of a target like https://\1... must start with exactly this host pattern.
HOST_GROUP = "([a-z0-9-]+(?:\\.[a-z0-9-]+)+"
HOST_FOLLOW = ("(?:[/?#]", ")/", ")(?:[/?#]")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DOMAIN_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
LITERAL_TARGET_RE = re.compile(r"^https://[a-z0-9-]+(?:\.[a-z0-9-]+)+/")
HOST_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
KEYS = ("rule", "source", "regex", "target", "exclude", "test", "miss")


class UnwrapError(ValueError):
    pass


def _compile(regex):
    return re.compile(regex, re.IGNORECASE)  # DNR regexFilter matches case-insensitively by default


def apply_once(entries, url):
    """(entry name, new URL) for the first entry whose regex matches url, else (None, url).
    The rules never overlap (checked by check_entries), so the first match is the only one."""
    for e in entries:
        m = e["compiled"].match(url)
        if m and m.end() == len(url):
            return e["name"], m.expand(e["target"])
    return None, url


def follow(entries, url):
    """Final URL after following every redirect; raises UnwrapError after MAX_HOPS (a loop)."""
    for _ in range(MAX_HOPS + 1):
        name, nxt = apply_once(entries, url)
        if name is None:
            return url
        url = nxt
    raise UnwrapError("more than %d redirects from %r (loop?)" % (MAX_HOPS, url))


def _check_output(url):
    p = urlsplit(url)
    if p.scheme != "https" or not p.hostname or not HOST_RE.match(p.hostname) or p.username or p.port \
            or p.netloc.lower() != p.hostname:
        return "not a plain https URL with a host name: %r" % url
    return None


def _check_pattern(e):
    errs = []
    regex, target = e["regex"], e["target"]
    if not regex.startswith("^https?://") or not regex.endswith("$"):
        errs.append("regex must start with ^https?:// and end with $")
    try:
        compiled = _compile(regex)
    except re.error as exc:
        return errs + ["regex does not compile: %s" % exc]
    e["compiled"] = compiled
    if not target.startswith("https://"):
        errs.append("target must start with https://")
    refs = [int(n) for n in re.findall(r"\\(\d)", target)]
    if any(n == 0 or n > compiled.groups for n in refs):
        errs.append("target uses a group the regex does not have (\\0 is not allowed)")
    if "$" in target or re.search(r"\\[^\d]", target):
        errs.append("target may only use \\1..\\9")
    if target.startswith("https://\\"):
        if not target.startswith("https://\\1"):
            errs.append("a target that starts with a group must start with https://\\1")
        start = regex.find("(", len("^https?://"))
        while start != -1 and regex.startswith("(?:", start):
            start = regex.find("(", start + 1)
        rest = regex[start + len(HOST_GROUP):] if start != -1 and regex.startswith(HOST_GROUP, start) else None
        if rest is None or not rest.startswith(HOST_FOLLOW):
            errs.append("group 1 must start with the host pattern %s followed by [/?#], a group end and /, or the end"
                        % HOST_GROUP)
    elif not LITERAL_TARGET_RE.match(target):
        errs.append("target must be https://<host>/... or https://\\1...")
    for d in e["exclude"]:
        if not DOMAIN_RE.match(d):
            errs.append("exclude: not a domain: %r" % d)
    if not e["tests"]:
        errs.append("needs at least one test line")
    return errs


def check_entries(entries):
    """Run every test and miss line against the whole list. Returns error strings."""
    errs = []
    for e in entries:
        for src, want in e["tests"]:
            hits = [o["name"] for o in entries if o["compiled"].fullmatch(src)]
            if hits != [e["name"]]:
                errs.append("%s: test %r is matched by %s, expected only this rule" % (e["name"], src, hits or "no rule"))
                continue
            try:
                got = follow(entries, src)
            except UnwrapError as exc:
                errs.append("%s: %s" % (e["name"], exc))
                continue
            if got != want:
                errs.append("%s: %r -> %r, expected %r" % (e["name"], src, got, want))
            bad = _check_output(got)
            if bad:
                errs.append("%s: %s" % (e["name"], bad))
        for src in e["misses"]:
            hits = [o["name"] for o in entries if o["compiled"].fullmatch(src)]
            if hits:
                errs.append("%s: miss %r is matched by %s" % (e["name"], src, hits))
    return errs


def parse(text):
    """Entries in list order (dicts). Raises UnwrapError on any problem, including failing tests."""
    entries, errors, cur = [], [], None
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, _, val = line.partition(" ")
        val = val.strip()
        if key not in KEYS or not val:
            errors.append("line %d: expected '<%s> <value>'" % (i, "|".join(KEYS)))
            continue
        if key == "rule":
            if not NAME_RE.match(val) or any(e["name"] == val for e in entries):
                errors.append("line %d: bad or duplicate rule name %r" % (i, val))
            cur = {"name": val, "line": i, "source": "", "regex": "", "target": "", "exclude": [], "tests": [], "misses": []}
            entries.append(cur)
            continue
        if cur is None:
            errors.append("line %d: %s before the first rule line" % (i, key))
            continue
        if key == "test":
            src, sep, want = val.partition(" => ")
            if not sep:
                errors.append("line %d: test needs '<URL> => <URL>'" % i)
            else:
                cur["tests"].append((src.strip(), want.strip()))
        elif key == "miss":
            cur["misses"].append(val)
        elif key == "exclude":
            cur["exclude"] = val.split()
        elif cur[key]:
            errors.append("line %d: second %s line in rule %s" % (i, key, cur["name"]))
        else:
            cur[key] = val
    if not entries and not errors:
        errors.append("the list is empty")
    for e in entries:
        missing = [k for k in ("source", "regex", "target") if not e[k]]
        if missing:
            errors.append("rule %s: missing %s" % (e["name"], ", ".join(missing)))
            continue
        errors.extend("rule %s: %s" % (e["name"], m) for m in _check_pattern(e))
    if not errors:
        errors.extend(check_entries(entries))
    if errors:
        raise UnwrapError("; ".join(errors))
    return entries


def build_rules(entries):
    rules = []
    for e in entries:
        cond = {"regexFilter": e["regex"], "resourceTypes": list(RESOURCE_TYPES)}
        if e["exclude"]:
            cond["excludedInitiatorDomains"] = list(e["exclude"])
        rules.append({
            "id": len(rules) + 1,
            "priority": PRIORITY,
            "action": {"type": "redirect", "redirect": {"regexSubstitution": e["target"]}},
            "condition": cond,
        })
    return rules


def read(root=ROOT):
    with open(os.path.join(root, SOURCE), encoding="utf-8") as fh:
        return parse(fh.read())


def write(root=ROOT):
    """Write rules/unwrap.json. Returns (rule_resources entry, build-info counts, entries)."""
    entries = read(root)
    rules = build_rules(entries)
    with open(os.path.join(root, OUTPUT), "w", encoding="utf-8") as fh:
        fh.write("[\n")
        fh.write(",\n".join(json.dumps(r, separators=(",", ":"), sort_keys=True) for r in rules))
        fh.write("\n]\n")
    entry = {"id": RULESET_ID, "enabled": True, "path": OUTPUT}
    meta = {"rules": len(rules), "block": 0, "allow": 0, "regex": len(rules)}
    return entry, meta, entries


def main():
    try:
        entries = read()
    except UnwrapError as e:
        print("ERROR", e)
        return 1
    tests = sum(len(e["tests"]) + len(e["misses"]) for e in entries)
    print("%d unwrap rules, %d test / miss lines pass (%s)" % (len(entries), tests, OUTPUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
