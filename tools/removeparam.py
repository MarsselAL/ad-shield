#!/usr/bin/env python3
"""Tracking-parameter removal: rules/removeparams.txt (our own list) -> rules/removeparam.json.

    python3 -I tools/removeparam.py     check the list and print what would be generated
The ruleset is written by tools/build_rules.py (full build and --curated-only), which also keeps
it in manifest.json, so it is rebuilt offline with:  python3 -I tools/build_rules.py --curated-only

Rule shape (Chrome declarativeNetRequest; queryTransform needs a redirect action):
  one rule per parameter name and separator ("?name=" and "&name="), each:
    action    redirect with transform.queryTransform.removeParams = every listed name, so the
              first match removes all of them in one redirect
    condition urlFilter "?name=" / "&name=" (case-sensitive, like removeParams), so a rule only
              fires when a listed parameter is present and the redirect always changes the URL
              (no loops, no useless redirects); resourceTypes main_frame + sub_frame only;
              excludedRequestDomains: ad-click redirectors that hand the click id on themselves
  priority  PRIORITY (50): above every list rule (1..4, so EasyList allow rules do not stop it),
            below the per-site allowlist rule (100, allowAllRequests), which therefore wins.
urlFilter rules instead of one alternation regexFilter: Chrome compiles each regexFilter with a
2 KB RE2 memory limit, which a 50-name alternation would exceed (the rule would be dropped);
plain urlFilters cost nothing against the 1,000-regex limit.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = "rules/removeparams.txt"
OUTPUT = "rules/removeparam.json"
RULESET_ID = "removeparam"
PRIORITY = 50
RESOURCE_TYPES = ["main_frame", "sub_frame"]
# Click redirectors that pass gclid / dclid on to the advertiser's page themselves.
EXCLUDED_DOMAINS = ["doubleclick.net", "googleadservices.com"]
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Names sites use for real content; refused even if someone adds them to the list.
NEVER = {"si", "ref", "ref_src", "ref_url", "source", "src", "id", "cid", "campaign", "spm", "mkt_tok",
         "q", "s", "t", "v", "p", "page", "lang", "token", "session", "code", "state", "tag"}


class RemoveparamError(ValueError):
    pass


def parse(text):
    """Names in list order. Raises RemoveparamError on a bad, duplicate or generic name."""
    names, errors = [], []
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if not NAME_RE.match(line):
            errors.append("line %d: not a parameter name: %r" % (i, line))
        elif line in NEVER or line.lower() in NEVER:
            errors.append("line %d: %r is too generic (sites use it for content)" % (i, line))
        elif line in names:
            errors.append("line %d: duplicate %r" % (i, line))
        else:
            names.append(line)
    if not names and not errors:
        errors.append("the list is empty")
    if errors:
        raise RemoveparamError("; ".join(errors))
    return names


def build_rules(names):
    rules = []
    for name in names:
        for sep in ("?", "&"):
            rules.append({
                "id": len(rules) + 1,
                "priority": PRIORITY,
                "action": {"type": "redirect", "redirect": {"transform": {"queryTransform": {"removeParams": list(names)}}}},
                "condition": {
                    "urlFilter": sep + name + "=",
                    "isUrlFilterCaseSensitive": True,
                    "resourceTypes": list(RESOURCE_TYPES),
                    "excludedRequestDomains": list(EXCLUDED_DOMAINS),
                },
            })
    return rules


def read(root=ROOT):
    with open(os.path.join(root, SOURCE), encoding="utf-8") as fh:
        return parse(fh.read())


def write(root=ROOT):
    """Write rules/removeparam.json. Returns (rule_resources entry, build-info counts, names)."""
    names = read(root)
    rules = build_rules(names)
    with open(os.path.join(root, OUTPUT), "w", encoding="utf-8") as fh:
        fh.write("[\n")
        fh.write(",\n".join(json.dumps(r, separators=(",", ":"), sort_keys=True) for r in rules))
        fh.write("\n]\n")
    entry = {"id": RULESET_ID, "enabled": True, "path": OUTPUT}
    meta = {"rules": len(rules), "block": 0, "allow": 0, "regex": 0, "params": len(names)}
    return entry, meta, names


def main():
    try:
        names = read()
    except RemoveparamError as e:
        print("ERROR", e)
        return 1
    print("%d parameter names -> %d rules (%s)" % (len(names), 2 * len(names), OUTPUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
