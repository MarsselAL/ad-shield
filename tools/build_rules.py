#!/usr/bin/env python3
"""Build the general blocking data in rules/ from EasyList, EasyPrivacy and the EasyList Cookie
List (converter: tools/filterlist.py, our own code).

    python3 -I tools/build_rules.py                 download the lists with curl into a fresh
                                                    temporary folder, then convert
    python3 -I tools/build_rules.py --lists DIR     use DIR/easylist.txt, DIR/easyprivacy.txt,
                                                    DIR/easylist-cookie.txt (offline rebuild)
    python3 -I tools/build_rules.py --curated-only  only rebuild the curated rulesets from
                                                    rules/curated_hosts.txt (no download; the
                                                    other generated files stay as they are)

Writes (all committed, so the extension works offline and needs no remote config):
    rules/ads_N.json, rules/privacy_N.json, rules/cookies_N.json   DNR block/allow rulesets
    rules/cookie_strip.json                                        DNR modifyHeaders ruleset
    rules/ads_curated.json, rules/privacy_curated.json             DNR block rulesets from our own
                                                                   rules/curated_hosts.txt (tools/curated.py)
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
import curated as C  # noqa: E402
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
# Numbered rulesets only: ads_curated.json / privacy_curated.json are rewritten by every build
# (full or --curated-only) but never deleted by the cleanup.
GENERATED_GLOBS = ["rules/ads_[0-9]*.json", "rules/privacy_[0-9]*.json", "rules/cookies_[0-9]*.json"]
CURATED_IDS = tuple(rid for _, rid in C.RULESETS)
_GROUPS = {"ads": 0, "privacy": 1, "cookies": 2, "cookie_strip": 3}


def ruleset_order_key(rid):
    """manifest order: ads_1.., ads_curated, privacy_1.., privacy_curated, cookies_1.., cookie_strip."""
    if rid in _GROUPS:
        return (_GROUPS[rid], 0)
    prefix, _, rest = rid.rpartition("_")
    if prefix not in _GROUPS:
        raise ValueError("unknown generated ruleset id %r" % rid)
    return (_GROUPS[prefix], float("inf") if rest == "curated" else int(rest))


def order_rulesets(entries):
    return sorted(entries, key=lambda r: ruleset_order_key(r["id"]))


def read_curated(root=ROOT):
    """Parse and check rules/curated_hosts.txt. Raises curated.CuratedError."""
    with open(os.path.join(root, C.SOURCE), encoding="utf-8") as fh:
        return C.build_curated(fh.read())


def write_curated(root=ROOT):
    """Write rules/ads_curated.json and rules/privacy_curated.json.
    Returns (rule_resources entries, {ruleset id: counts}, build-info `curated` entry)."""
    rules, cinfo = read_curated(root)
    entries, metas = [], {}
    for rid in CURATED_IDS:
        rs = rules[rid]
        write_rules(os.path.join(root, "rules", rid + ".json"), rs)
        entries.append({"id": rid, "enabled": True, "path": "rules/%s.json" % rid})
        metas[rid] = {"rules": len(rs), "block": len(rs), "allow": 0, "regex": 0}
    return entries, metas, cinfo


def add_curated_info(info, metas, cinfo):
    info.setdefault("rulesets", {}).update(metas)
    info["curated"] = cinfo
    info["totalStaticRules"] = sum(v["rules"] for v in info["rulesets"].values())
    return info


def write_build_info(info, root=ROOT):
    with open(os.path.join(root, "rules", "build-info.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=2, sort_keys=True)
        fh.write("\n")


def curated_only(root=ROOT):
    """Regenerate only the curated rulesets, the manifest rule_resources and the `curated` entry of
    rules/build-info.json. Nothing is downloaded; the other generated files are not touched."""
    read_curated(root)  # fail before writing anything
    with open(os.path.join(root, "manifest.json"), encoding="utf-8") as fh:
        current = json.load(fh).get("declarative_net_request", {}).get("rule_resources", [])
    twitch = {r["id"] for r in TWITCH_RULESETS}
    keep = [r for r in current if r.get("id") not in twitch and r.get("id") not in CURATED_IDS]
    entries, metas, cinfo = write_curated(root)
    info_path = os.path.join(root, "rules", "build-info.json")
    info = {}
    if os.path.isfile(info_path):
        with open(info_path, encoding="utf-8") as fh:
            info = json.load(fh)
    add_curated_info(info, metas, cinfo)
    write_build_info(info, root)
    changed = update_manifest(order_rulesets(keep + entries), root)
    return info, changed


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


def convert_texts(texts):
    """Pure conversion of the three lists. texts: {list key: file text}. Returns a dict:
    lists      {key: build-info entry without url, plus "rules" (block ids from 1, allow ids
               from ALLOW_ID_BASE + 1, before splitting into rulesets)}
    site       the rules/cosmetic/site.json object
    generic    {"ads": [...], "cookies": [...]} generic selectors (rules/cosmetic/generic.json)
    cosmetic   {"ads": CosmeticCollector, "cookies": CosmeticCollector} (finished)
    exceptions {host: set(selectors)}; cookieDomains: EasyPrivacy ||host^$third-party hosts.
    src/shared/filterlist.js ports this function; tests/fixtures/lists/golden.json (written by
    tools/make_golden.py) keeps the two in step."""
    out = {"lists": {}}
    cosmetic = {"ads": F.CosmeticCollector(), "cookies": F.CosmeticCollector()}
    generichide, elemhide = set(), set()
    cookie_domains = []
    for key, _name, _url, _prefix, category in LISTS:
        lines = texts[key].splitlines()
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
        out["lists"][key] = {
            "version": header_value(lines, "Version") or header_value(lines, "Last modified"),
            "licence": header_value(lines, "Licence") or header_value(lines, "License"),
            "filters": n_filters,
            "networkConverted": len(parsed),
            "cosmeticConverted": n_cos,
            "mergedDomains": st["merged-domains"],
            "duplicates": st["duplicates"],
            "skipped": dict(sorted(skipped.items())),
            "skippedTotal": sum(skipped.values()),
            "rules": rules,
        }
    exceptions = {}
    for c in cosmetic.values():
        c.finish()
        for h, sels in c.exceptions.items():
            exceptions.setdefault(h, set()).update(sels)
    generic_all = set(cosmetic["ads"].generic) | set(cosmetic["cookies"].generic)
    generic_exc_hosts = sorted(h for h, sels in exceptions.items() if sels & generic_all)
    out["site"] = {
        "v": 1,
        "ads": {h: s for h, s in sorted(cosmetic["ads"].site.items())},
        "cookies": {h: s for h, s in sorted(cosmetic["cookies"].site.items())},
        "exceptions": {h: sorted(s) for h, s in sorted(exceptions.items())},
        "genericExceptionHosts": generic_exc_hosts,
        "generichide": sorted(generichide),
        "elemhide": sorted(elemhide),
    }
    out["generic"] = {"ads": cosmetic["ads"].generic, "cookies": cosmetic["cookies"].generic}
    out["cosmetic"] = cosmetic
    out["exceptions"] = exceptions
    out["cookieDomains"] = cookie_domains
    return out


def convert(lists_dir, root=ROOT):
    texts = {}
    for key, name, _url, _prefix, _category in LISTS:
        with open(os.path.join(lists_dir, name), encoding="utf-8") as fh:
            texts[key] = fh.read()
    conv = convert_texts(texts)
    info = {"lists": {}, "rulesets": {}, "cosmetic": {}, "cookieStrip": {}}
    rulesets = []
    for key, name, url, prefix, category in LISTS:
        entry = dict(conv["lists"][key])
        rules = entry.pop("rules")
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
        entry["url"] = url
        info["lists"][key] = entry

    cookie_domains = conv["cookieDomains"]
    strip, n_strip = F.cookie_strip_rules(cookie_domains, COOKIE_STRIP_CAP)
    write_rules(os.path.join(root, "rules", "cookie_strip.json"), strip)
    rulesets.append({"id": "cookie_strip", "enabled": True, "path": "rules/cookie_strip.json"})
    info["rulesets"]["cookie_strip"] = {"rules": len(strip), "block": len(strip), "allow": 0, "regex": 0}
    info["cookieStrip"] = {"candidates": len(set(cookie_domains)), "cap": COOKIE_STRIP_CAP, "domains": n_strip}

    # Cosmetic data
    cosmetic = conv["cosmetic"]
    site = conv["site"]
    cdir = os.path.join(root, "rules", "cosmetic")
    os.makedirs(cdir, exist_ok=True)
    for cat, c in cosmetic.items():
        with open(os.path.join(cdir, "%s_generic.css" % cat), "w", encoding="utf-8") as fh:
            fh.write("/* GENERATED by tools/build_rules.py from %s; see rules/NOTICE.md */\n" %
                     ("EasyList" if cat == "ads" else "the EasyList Cookie List"))
            fh.write(F.generic_css(c.generic))
    with open(os.path.join(cdir, "generic.json"), "w", encoding="utf-8") as fh:
        json.dump(conv["generic"], fh, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(cdir, "site.json"), "w", encoding="utf-8") as fh:
        json.dump(site, fh, separators=(",", ":"), ensure_ascii=False)
    for cat, c in cosmetic.items():
        info["cosmetic"][cat] = {
            "generic": len(c.generic),
            "siteHosts": len(c.site),
            "siteSelectors": sum(len(v) for v in c.site.values()),
        }
    info["cosmetic"]["exceptionHosts"] = len(conv["exceptions"])
    info["cosmetic"]["genericExceptionHosts"] = len(site["genericExceptionHosts"])
    info["cosmetic"]["generichide"] = len(site["generichide"])
    info["cosmetic"]["elemhide"] = len(site["elemhide"])
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


def print_summary(info, changed):
    for rid, v in info["rulesets"].items():
        print("%-16s %6d rules (%d allow, %d regex)" % (rid, v["rules"], v["allow"], v["regex"]))
    for k, v in info.get("lists", {}).items():
        print("%-16s %6d filters, %d skipped" % (k, v["filters"], v["skippedTotal"]))
    c = info["curated"]
    print("curated          ads %d hosts (%d excluded), trackers %d hosts (%d excluded), never %d" % (
        c["ads"]["hosts"], c["ads"]["exclusions"], c["trackers"]["hosts"], c["trackers"]["exclusions"], c["never"]))
    print("total static rules", info["totalStaticRules"], "| manifest", "updated" if changed else "unchanged")


def main(argv):
    lists_dir = None
    if len(argv) == 2 and argv[1] == "--curated-only":
        try:
            info, changed = curated_only()
        except C.CuratedError as e:
            print("ERROR", e)
            return 1
        print_summary(info, changed)
        return 0
    if len(argv) == 3 and argv[1] == "--lists":
        lists_dir = os.path.abspath(argv[2])
    elif len(argv) != 1:
        print(__doc__)
        return 2
    try:
        read_curated()  # fail before downloading or deleting anything
    except C.CuratedError as e:
        print("ERROR", e)
        return 1
    if lists_dir is None:
        lists_dir = tempfile.mkdtemp(prefix="adshield-lists-")
        download(lists_dir)
    # Remove rulesets from a previous build that this build may not produce again.
    for pattern in GENERATED_GLOBS:
        for f in glob.glob(os.path.join(ROOT, pattern)):
            os.remove(f)
    rulesets, info = convert(lists_dir)
    entries, metas, cinfo = write_curated()
    add_curated_info(info, metas, cinfo)
    write_build_info(info)
    changed = update_manifest(order_rulesets(rulesets + entries))
    print_summary(info, changed)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
