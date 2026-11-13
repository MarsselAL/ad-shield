#!/usr/bin/env python3
"""Build the general blocking data in rules/ from EasyList, EasyPrivacy and the EasyList Cookie
List (converter: tools/filterlist.py, our own code).

    python3 -I tools/build_rules.py                 download the lists with curl into a fresh
                                                    temporary folder, then convert
    python3 -I tools/build_rules.py --lists DIR     use DIR/easylist.txt, DIR/easyprivacy.txt,
                                                    DIR/easylist-cookie.txt (offline rebuild)

Writes (all committed, so the extension works offline and needs no remote config):
    rules/ads_N.json, rules/privacy_N.json, rules/cookies_N.json   DNR block/allow rulesets
    rules/cookie_strip.json                                        DNR modifyHeaders ruleset
    rules/cosmetic/ads_generic.css, rules/cosmetic/cookies_generic.css
    rules/cosmetic/generic.json, rules/cosmetic/site.json          cosmetic data for the worker
    rules/build-info.json                                          list versions, counts, skips
and updates declarative_net_request.rule_resources in manifest.json.
The list data is used under CC BY-SA 3.0 (EasyList, EasyPrivacy) and CC BY 3.0 (cookie list);
see rules/NOTICE.md.
"""
import collections
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import filterlist as F  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LISTS = [
    # (key, file name, url, ruleset prefix, cosmetic category)
    ("easylist", "easylist.txt", "https://easylist.to/easylist/easylist.txt", "ads", "ads"),
    ("easyprivacy", "easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt", "privacy", None),
    ("easylist-cookie", "easylist-cookie.txt", "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt", "cookies", "cookies"),
]
COOKIE_STRIP_CAP = 10000
TWITCH_RULESETS = [
    {"id": "client_ads", "enabled": True, "path": "rules/client_ads.json"},
    {"id": "trackers", "enabled": False, "path": "rules/trackers.json"},
]
GENERATED_GLOBS = ["rules/ads_*.json", "rules/privacy_*.json", "rules/cookies_*.json"]


def download(dest):
    for _, name, url, _, _ in LISTS:
        out = os.path.join(dest, name)
        print("download", url)
        subprocess.check_call(["curl", "-fsSL", "--max-time", "120", "--proto", "=https", "-o", out, url])


def header_value(lines, key):
    for line in lines[:40]:
        m = re.match(r"^!\s*%s:\s*(.+)$" % re.escape(key), line.strip(), re.I)
        if m:
            return m.group(1).strip()
    return None


def write_rules(path, rules):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("[\n")
        fh.write(",\n".join(json.dumps(r, separators=(",", ":"), sort_keys=True) for r in rules))
        fh.write("\n]\n")


def convert(lists_dir, root=ROOT):
    info = {"lists": {}, "rulesets": {}, "cosmetic": {}, "cookieStrip": {}}
    cosmetic = {"ads": F.CosmeticCollector(), "cookies": F.CosmeticCollector()}
    generichide, elemhide = set(), set()
    rulesets = []
    cookie_domains = []
    for key, name, url, prefix, category in LISTS:
        path = os.path.join(lists_dir, name)
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        skipped = collections.Counter()
        parsed = []
        n_filters = n_cos = 0
        for line in lines:
            kind, val = F.classify(line)
            if kind == "comment":
                continue
            n_filters += 1
            try:
                if kind == "cosmetic":
                    exc, inc, neg, sel = F.parse_cosmetic(*val)
                    if category is None:
                        raise F.Skip("cosmetic-in-network-list")
                    cosmetic[category].add(exc, inc, neg, sel)
                    n_cos += 1
                    continue
                p = F.parse_network(val)
                if p.get("cosmetic_exception"):
                    if "elemhide" in p["cosmetic_exception"]:
                        elemhide.add(p["host"])
                    else:
                        generichide.add(p["host"])
                    n_cos += 1
                    continue
                parsed.append(p)
                if key == "easyprivacy":
                    d = F.is_tracker_cookie_domain(val)
                    if d:
                        cookie_domains.append(d)
            except F.Skip as e:
                skipped[str(e)] += 1
        rules, st = F.build_network_rules(parsed)
        skipped["regex-cap"] += st["regex-cap"]
        chunks = F.split_rulesets(rules)
        for i, chunk in enumerate(chunks):
            rid = "%s_%d" % (prefix, i + 1)
            write_rules(os.path.join(root, "rules", rid + ".json"), chunk)
            rulesets.append({"id": rid, "enabled": True, "path": "rules/%s.json" % rid})
            info["rulesets"][rid] = {
                "rules": len(chunk),
                "block": sum(1 for r in chunk if r["id"] < F.ALLOW_ID_BASE),
                "allow": sum(1 for r in chunk if r["id"] >= F.ALLOW_ID_BASE),
                "regex": sum(1 for r in chunk if "regexFilter" in r["condition"]),
            }
        info["lists"][key] = {
            "url": url,
            "version": header_value(lines, "Version") or header_value(lines, "Last modified"),
            "licence": header_value(lines, "Licence") or header_value(lines, "License"),
            "filters": n_filters,
            "networkConverted": len(parsed),
            "cosmeticConverted": n_cos,
            "mergedDomains": st["merged-domains"],
            "duplicates": st["duplicates"],
            "skipped": dict(sorted(skipped.items())),
            "skippedTotal": sum(skipped.values()),
        }

    strip, n_strip = F.cookie_strip_rules(cookie_domains, COOKIE_STRIP_CAP)
    write_rules(os.path.join(root, "rules", "cookie_strip.json"), strip)
    rulesets.append({"id": "cookie_strip", "enabled": True, "path": "rules/cookie_strip.json"})
    info["rulesets"]["cookie_strip"] = {"rules": len(strip), "block": len(strip), "allow": 0, "regex": 0}
    info["cookieStrip"] = {"candidates": len(set(cookie_domains)), "cap": COOKIE_STRIP_CAP, "domains": n_strip}

    # Cosmetic data
    cdir = os.path.join(root, "rules", "cosmetic")
    os.makedirs(cdir, exist_ok=True)
    exceptions = {}
    for c in cosmetic.values():
        c.finish()
        for h, sels in c.exceptions.items():
            exceptions.setdefault(h, set()).update(sels)
    generic_all = set(cosmetic["ads"].generic) | set(cosmetic["cookies"].generic)
    generic_exc_hosts = sorted(h for h, sels in exceptions.items() if sels & generic_all)
    for cat, c in cosmetic.items():
        with open(os.path.join(cdir, "%s_generic.css" % cat), "w", encoding="utf-8") as fh:
            fh.write("/* GENERATED by tools/build_rules.py from %s; see rules/NOTICE.md */\n" %
                     ("EasyList" if cat == "ads" else "the EasyList Cookie List"))
            fh.write(F.generic_css(c.generic))
    with open(os.path.join(cdir, "generic.json"), "w", encoding="utf-8") as fh:
        json.dump({"ads": cosmetic["ads"].generic, "cookies": cosmetic["cookies"].generic}, fh,
                  separators=(",", ":"), ensure_ascii=False)
    site = {
        "v": 1,
        "ads": {h: s for h, s in sorted(cosmetic["ads"].site.items())},
        "cookies": {h: s for h, s in sorted(cosmetic["cookies"].site.items())},
        "exceptions": {h: sorted(s) for h, s in sorted(exceptions.items())},
        "genericExceptionHosts": generic_exc_hosts,
        "generichide": sorted(generichide),
        "elemhide": sorted(elemhide),
    }
    with open(os.path.join(cdir, "site.json"), "w", encoding="utf-8") as fh:
        json.dump(site, fh, separators=(",", ":"), ensure_ascii=False)
    for cat, c in cosmetic.items():
        info["cosmetic"][cat] = {
            "generic": len(c.generic),
            "siteHosts": len(c.site),
            "siteSelectors": sum(len(v) for v in c.site.values()),
        }
    info["cosmetic"]["exceptionHosts"] = len(exceptions)
    info["cosmetic"]["genericExceptionHosts"] = len(generic_exc_hosts)
    info["cosmetic"]["generichide"] = len(generichide)
    info["cosmetic"]["elemhide"] = len(elemhide)
    info["totalStaticRules"] = sum(v["rules"] for v in info["rulesets"].values())
    return rulesets, info


def update_manifest(rulesets, root=ROOT):
    path = os.path.join(root, "manifest.json")
    with open(path, encoding="utf-8") as fh:
        m = json.load(fh)
    want = TWITCH_RULESETS + rulesets
    dnr = m.setdefault("declarative_net_request", {})
    if dnr.get("rule_resources") == want:
        return False
    dnr["rule_resources"] = want
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(m, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return True


def main(argv):
    lists_dir = None
    if len(argv) == 3 and argv[1] == "--lists":
        lists_dir = os.path.abspath(argv[2])
    elif len(argv) != 1:
        print(__doc__)
        return 2
    if lists_dir is None:
        lists_dir = tempfile.mkdtemp(prefix="adshield-lists-")
        download(lists_dir)
    # Remove rulesets from a previous build that this build may not produce again.
    for pattern in GENERATED_GLOBS:
        for f in glob.glob(os.path.join(ROOT, pattern)):
            os.remove(f)
    rulesets, info = convert(lists_dir)
    with open(os.path.join(ROOT, "rules", "build-info.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=2, sort_keys=True)
        fh.write("\n")
    changed = update_manifest(rulesets)
    for rid, v in info["rulesets"].items():
        print("%-14s %6d rules (%d allow, %d regex)" % (rid, v["rules"], v["allow"], v["regex"]))
    for k, v in info["lists"].items():
        print("%-16s %6d filters, %d skipped" % (k, v["filters"], v["skippedTotal"]))
    print("total static rules", info["totalStaticRules"], "| manifest", "updated" if changed else "unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
