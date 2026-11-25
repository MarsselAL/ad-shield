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


def write_cosmetic(cdir, generic, site):
    """Write every file of rules/cosmetic/ that comes from the lists.
    generic: {"ads": [...], "cookies": [...]}; site: the site-specific object (shape of site.json).
    Returns build-info numbers."""
    os.makedirs(cdir, exist_ok=True)
    core, top = split_ad_tiers(generic["ads"])
    files = {
        "ads_generic.css": css_file(core, "EasyList (generic core, every frame)"),
        "ads_generic_top.css": css_file(top, "EasyList (other generic, top frame)"),
        "cookies_generic.css": css_file(generic["cookies"], "the EasyList Cookie List (top frame)"),
    }
    for name, text in files.items():
        with open(os.path.join(cdir, name), "w", encoding="utf-8") as fh:
            fh.write(text)
    with open(os.path.join(cdir, "generic.json"), "w", encoding="utf-8") as fh:
        json.dump(generic, fh, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(cdir, "site.json"), "w", encoding="utf-8") as fh:
        json.dump(site, fh, separators=(",", ":"), ensure_ascii=False)
    return {"adsCore": len(core), "adsTop": len(top)}


def read_committed(root=ROOT):
    cdir = os.path.join(root, "rules", "cosmetic")
    with open(os.path.join(cdir, "generic.json"), encoding="utf-8") as fh:
        generic = json.load(fh)
    with open(os.path.join(cdir, "site.json"), encoding="utf-8") as fh:
        site = json.load(fh)
    return generic, site


def main():
    generic, site = read_committed()
    n = write_cosmetic(os.path.join(ROOT, "rules", "cosmetic"), generic, site)
    print("ads core %d selectors (every frame), ads top %d (top frame), cookies %d (top frame)" % (
        n["adsCore"], n["adsTop"], len(generic["cookies"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
