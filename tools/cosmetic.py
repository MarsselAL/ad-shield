#!/usr/bin/env python3
"""Cosmetic output files in rules/cosmetic/ (pure functions + writer; our own code, MIT).

Called by tools/build_rules.py after converting the lists. Can also be run on its own to rebuild
the cosmetic files from the committed data, without downloading anything:

    python3 -I tools/cosmetic.py      reads rules/cosmetic/generic.json and the site data,
                                      rewrites the CSS files (and the other cosmetic outputs)

Generic ad hiding is split in two tiers (measured 2026-11-25: EasyList has 13,635 generic
selectors, 207 KB; the cookie list 15,272, 290 KB; none of them has a site key):

  core (ads_generic.css, every frame): selectors made only of generic ad vocabulary ("ad", "ads",
      "advert", "sponsored", "dfp", "gpt" ... plus position / container words such as "top",
      "sidebar", "box", "slot", "wrapper" and IAB sizes like 300x250; tag and attribute names such
      as div, id, data are allowed and not counted), at most CORE_MAX_TOKENS words and
      CORE_MAX_LEN characters, with at least one ad word. These are the class / id names
      ad slots use across unrelated sites (#ad-top, .adsbygoogle, [id^="div-gpt-ad"]), unlike names
      tied to one site, CMS plugin or network (#rightrail_pos1_ddb_0, .widget_wpstealthads_widget,
      a[href^="https://..."]). Ranked by word count, then length, and capped at CORE_MAX_BYTES.
  top (ads_generic_top.css, top frame only): every other generic ad selector.

Cookie-banner generic hiding (cookies_generic.css) runs in the top frame only. Nothing is dropped:
the two ad tiers together are exactly the generic ad selectors, so the top frame keeps the whole
generic list and sub-frames (ad iframes, widgets) get the small core.

Generic selectors that some site excepts (`site#@#sel`, `~site##sel`; 527 today, 8 KB) are kept
out of those three files and go to ads_excepted.css (every frame) / cookies_excepted.css (top
frame), which skip the hosts in genericExceptionHosts. For those hosts the worker injects
generic_excepted.json minus the host's exceptions, so the big files need no host exclusions
other than generichide / elemhide / genericFullHosts, and the worker never parses the whole
generic list for them. generic.json (every generic selector) stays for genericFullHosts: hosts
whose exceptions, after a weekly list update, hit a packaged generic selector outside the
excepted set (none in the packaged data); they skip all generic files and get the whole list.

Site-specific data is sharded so that a cold service worker reads one small file per page:
site/index.json (genericExceptionHosts, generichide, elemhide, genericFullHosts: what the
content-script registration needs) and site/00.json .. site/7f.json (SITE_SHARDS files, each
the shape of the old site.json restricted to its hosts). A host's shard is fnv1a(shard_key) %
SITE_SHARDS, where shard_key is the last two labels, or the last three when the second-to-last
is a common second-level label (co.uk, com.au ...), so every parent of a page host that can hold
rules is in the same shard; one-label hosts and two-label public-suffix-like hosts (gov.uk) are
copied into every shard. src/shared/blocking.js has the same functions (siteShard, splitSite).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import filterlist as F  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CORE_MAX_BYTES = 40000     # selector text (+1 per selector) in ads_generic.css
CORE_MAX_TOKENS = 4
CORE_MAX_LEN = 40

# Words that say "this is an ad".
AD_WORDS = frozenset("""
ad ads adv advert adverts advertise advertisement advertisements advertising advertorial
sponsor sponsored sponsors adsense adsbygoogle adslot adunit adbox adbanner adsbox adspace adzone
adarea adcontainer adwrapper adlabel adtext adlink adlinks adblock adframe dfp gpt taboola outbrain
""".split())
# Generic position, size and container words that ad slots combine with the ad words.
PLACE_WORDS = frozenset("""
top bottom btm bot left right side sidebar header footer middle mid center inline content container
wrapper wrap box block area zone space slot unit frame iframe label title text link links widget
section column col row main home page post article sticky fixed float mobile desktop leaderboard
skyscraper sky rectangle rect square mpu billboard banner horizontal vertical small large big wide
inner outer holder placeholder display google native module panel bar spot position placement
responsive overlay popup lazy in first second one two amp
""".split())
# Tag and attribute names ([id^="div-gpt-ad"], ins.adsbygoogle[data-ad-client]): allowed, not counted.
STRUCT_WORDS = frozenset("id class name data client div ins span aside iframe".split())
_IAB_SIZE = re.compile(r"^\d{2,3}x\d{2,3}$")
_WORD = re.compile(r"\d{2,3}x\d{2,3}|[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")


def selector_words(sel):
    """Lower-case words of a selector: identifiers split at -, _, camelCase and digits;
    "300x250" stays one word."""
    out = []
    for chunk in re.findall(r"[A-Za-z0-9]+", sel.replace("\\", "")):
        out.extend(w.lower() for w in _WORD.findall(chunk))
    return out


def meaningful_words(sel):
    """selector_words without tag / attribute names, or None when a word is not generic vocabulary."""
    out = []
    for w in selector_words(sel):
        if w in STRUCT_WORDS:
            continue
        if not (w in AD_WORDS or w in PLACE_WORDS or _IAB_SIZE.match(w) or (w.isdigit() and len(w) == 1)):
            return None
        out.append(w)
    return out


def is_core_candidate(sel):
    if len(sel) > CORE_MAX_LEN:
        return False
    words = meaningful_words(sel)
    if not words or len(words) > CORE_MAX_TOKENS:
        return False
    return any(w in AD_WORDS for w in words)


def split_ad_tiers(selectors, budget=CORE_MAX_BYTES):
    """(core, top): both in list order; core + top == selectors (as sets, no overlap)."""
    ranked = sorted(
        (i for i, s in enumerate(selectors) if is_core_candidate(s)),
        key=lambda i: (len(meaningful_words(selectors[i])), len(selectors[i]), i))
    keep, used = set(), 0
    for i in ranked:
        cost = len(selectors[i]) + 1
        if used + cost > budget:
            break
        keep.add(i)
        used += cost
    core = [s for i, s in enumerate(selectors) if i in keep]
    top = [s for i, s in enumerate(selectors) if i not in keep]
    return core, top


def css_file(selectors, source):
    return ("/* GENERATED by tools/build_rules.py from %s; see rules/NOTICE.md */\n" % source) + F.generic_css(selectors)


# ---------------------------------------------------------------- site shards
SITE_SHARDS = 128          # must equal SITE_SHARDS in src/shared/blocking.js
SITE_DIR = "site"
SLD_LABELS = frozenset("ac co com edu gob gov gv ltd mil ne net nhs nic or org plc sch".split())
SITE_LISTS = ("genericExceptionHosts", "generichide", "elemhide", "genericFullHosts")
SITE_MAPS = ("ads", "cookies", "exceptions")


def fnv1a(text):
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def is_global_host(host):
    labels = host.split(".")
    return len(labels) == 1 or (len(labels) == 2 and labels[0] in SLD_LABELS)


def shard_key(host):
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    return ".".join(labels[-3:] if labels[-2] in SLD_LABELS else labels[-2:])


def shard_of(host):
    return fnv1a(shard_key(host)) % SITE_SHARDS


def shard_name(i):
    return "%02x" % i


def split_site(site):
    """(index, [shard objects]) for a site object (v 1 shape; genericFullHosts optional)."""
    shards = [{k: {} for k in SITE_MAPS} for _ in range(SITE_SHARDS)]
    for sh in shards:
        for k in SITE_LISTS:
            sh[k] = []

    def targets(h):
        return shards if is_global_host(h) else [shards[shard_of(h)]]

    for k in SITE_MAPS:
        for h, sels in (site.get(k) or {}).items():
            for sh in targets(h):
                sh[k][h] = sels
    for k in SITE_LISTS:
        for h in site.get(k) or []:
            for sh in targets(h):
                sh[k].append(h)
    index = {"v": 2, "n": SITE_SHARDS}
    for k in SITE_LISTS:
        index[k] = list(site.get(k) or [])
    return index, shards


def merge_site(index, shards):
    """Inverse of split_site (the v 1 site object, genericFullHosts kept)."""
    site = {"v": 1}
    for k in SITE_MAPS:
        merged = {}
        for sh in shards:
            merged.update(sh[k])
        site[k] = {h: merged[h] for h in sorted(merged)}
    for k in SITE_LISTS:
        site[k] = list(index[k])
    return site


def excepted_selectors(generic, site):
    """{"ads": [...], "cookies": [...]}: generic selectors that some host excepts (list order)."""
    exc = set()
    for sels in (site.get("exceptions") or {}).values():
        exc.update(sels)
    return {cat: [s for s in generic[cat] if s in exc] for cat in ("ads", "cookies")}


def full_generic_hosts(site, generic, excepted):
    """Hosts whose exceptions hit a generic selector that is not in `excepted`."""
    gen = set(generic["ads"]) | set(generic["cookies"])
    ok = set(excepted["ads"]) | set(excepted["cookies"])
    return sorted(h for h, sels in (site.get("exceptions") or {}).items() if any(s in gen and s not in ok for s in sels))


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def write_cosmetic(cdir, generic, site):
    """Write every file of rules/cosmetic/ that comes from the lists.
    generic: {"ads": [...], "cookies": [...]}; site: the site-specific object (v 1 shape, as
    build_rules.convert_texts makes it). Returns build-info numbers."""
    os.makedirs(cdir, exist_ok=True)
    excepted = excepted_selectors(generic, site)
    site = dict(site)
    site["genericFullHosts"] = full_generic_hosts(site, generic, excepted)
    skip = set(excepted["ads"]) | set(excepted["cookies"])
    core, top = split_ad_tiers([s for s in generic["ads"] if s not in skip])
    files = {
        "ads_generic.css": css_file(core, "EasyList (generic core, every frame)"),
        "ads_generic_top.css": css_file(top, "EasyList (other generic, top frame)"),
        "cookies_generic.css": css_file([s for s in generic["cookies"] if s not in skip], "the EasyList Cookie List (top frame)"),
        "ads_excepted.css": css_file(excepted["ads"], "EasyList (generic, excepted on some sites)"),
        "cookies_excepted.css": css_file(excepted["cookies"], "the EasyList Cookie List (generic, excepted on some sites)"),
    }
    for name, text in files.items():
        with open(os.path.join(cdir, name), "w", encoding="utf-8") as fh:
            fh.write(text)
    _dump(os.path.join(cdir, "generic.json"), generic)
    _dump(os.path.join(cdir, "generic_excepted.json"), excepted)
    index, shards = split_site(site)
    sdir = os.path.join(cdir, SITE_DIR)
    os.makedirs(sdir, exist_ok=True)
    for f in os.listdir(sdir):
        if f.endswith(".json"):
            os.remove(os.path.join(sdir, f))
    _dump(os.path.join(sdir, "index.json"), index)
    for i, sh in enumerate(shards):
        _dump(os.path.join(sdir, shard_name(i) + ".json"), sh)
    old = os.path.join(cdir, "site.json")
    if os.path.exists(old):
        os.remove(old)
    return {"adsCore": len(core), "adsTop": len(top), "adsExcepted": len(excepted["ads"]),
            "cookiesExcepted": len(excepted["cookies"]), "genericFullHosts": len(site["genericFullHosts"])}


def read_site(cdir):
    """The site object from site/ (or a leftover site.json)."""
    old = os.path.join(cdir, "site.json")
    if os.path.exists(old):
        with open(old, encoding="utf-8") as fh:
            return json.load(fh)
    sdir = os.path.join(cdir, SITE_DIR)
    with open(os.path.join(sdir, "index.json"), encoding="utf-8") as fh:
        index = json.load(fh)
    shards = []
    for i in range(index["n"]):
        with open(os.path.join(sdir, shard_name(i) + ".json"), encoding="utf-8") as fh:
            shards.append(json.load(fh))
    return merge_site(index, shards)


def read_committed(root=ROOT):
    cdir = os.path.join(root, "rules", "cosmetic")
    with open(os.path.join(cdir, "generic.json"), encoding="utf-8") as fh:
        generic = json.load(fh)
    return generic, read_site(cdir)


def main():
    generic, site = read_committed()
    site.pop("genericFullHosts", None)  # recomputed
    n = write_cosmetic(os.path.join(ROOT, "rules", "cosmetic"), generic, site)
    print("ads core %d selectors (every frame), ads top %d (top frame), cookies %d (top frame), excepted %d + %d, "
          "site shards %d" % (n["adsCore"], n["adsTop"], len(generic["cookies"]) - n["cookiesExcepted"],
                              n["adsExcepted"], n["cookiesExcepted"], SITE_SHARDS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
