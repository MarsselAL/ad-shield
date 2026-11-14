"""Parser and DNR rule generator for rules/curated_hosts.txt (this project's own host list, MIT).

Pure functions, no I/O. Format (see the header of rules/curated_hosts.txt):

    # comment                  ignored, as are blank lines
    [ads] / [trackers]         a blocked section (toggled by the Ads / Trackers switches)
    host.example               block this host and its subdomains (third-party requests only)
    -sub.host.example          exclude this host and its subdomains from the section's rule
    [never]                    hosts that must never be blocked by a curated rule

Each blocked section becomes ONE static DNR rule:
    {"id": 1, "priority": 1, "action": {"type": "block"},
     "condition": {"requestDomains": [...], "domainType": "thirdParty"
                   [, "excludedRequestDomains": [...]]}}
No resourceTypes, so Chrome's default applies (every type except main_frame).
Any problem raises CuratedError with the line number, so the build fails instead of shipping a
half-checked list.
"""
import re

SOURCE = "rules/curated_hosts.txt"
# (section, ruleset id); the order is the order in manifest.json within each group.
RULESETS = (("ads", "ads_curated"), ("trackers", "privacy_curated"))
BLOCK_SECTIONS = tuple(s for s, _ in RULESETS)
SECTIONS = BLOCK_SECTIONS + ("never",)
RULE_ID = 1  # below filterlist.ALLOW_ID_BASE (500000): counted as a block match
PRIORITY = 1  # same as the EasyList block rules: `@@` exceptions (2) and the allowlist (100) win

_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_SECTION_RE = re.compile(r"^\[([^\]]*)\]$")


class CuratedError(ValueError):
    """The curated host list is invalid; the message says where and why."""


def _covers(parent, host):
    return host == parent or host.endswith("." + parent)


def check_host(host):
    """None if `host` is a valid lowercase ASCII (punycode) host name with at least two labels,
    else the reason it is not."""
    if not host.isascii():
        return "not ASCII (write internationalised names in punycode, xn--...)"
    if host != host.lower():
        return "not lowercase"
    if len(host) > 253:
        return "longer than 253 characters"
    labels = host.split(".")
    if len(labels) < 2:
        return "a single label would block a whole top-level domain"
    for label in labels:
        if not _LABEL_RE.match(label):
            return "invalid label %r" % label
        if label.startswith("xn--"):
            try:
                label.encode("ascii").decode("idna")
            except UnicodeError:
                return "invalid punycode label %r" % label
    return None


def parse_curated(text):
    """Parse the list. Returns {"ads": {"hosts": [...], "exclusions": [...]}, "trackers": {...},
    "never": [...]}, every list sorted. Raises CuratedError on syntax errors, invalid hosts,
    duplicates, unknown sections, empty blocked sections and exclusions that exclude nothing."""
    out = {s: {"hosts": [], "exclusions": []} for s in BLOCK_SECTIONS}
    out["never"] = []
    seen_sections = set()
    seen_hosts = {}  # blocked host or ("never", host) -> (line number, section)
    seen_excl = {}
    excl_lines = {}
    section = None
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = "%s line %d" % (SOURCE, n)
        m = _SECTION_RE.match(line)
        if m:
            name = m.group(1)
            if name not in SECTIONS:
                raise CuratedError("%s: unknown section [%s] (expected %s)" %
                                   (where, name, ", ".join("[%s]" % s for s in SECTIONS)))
            if name in seen_sections:
                raise CuratedError("%s: duplicate section [%s]" % (where, name))
            seen_sections.add(name)
            section = name
            continue
        if section is None:
            raise CuratedError("%s: host %r before any section" % (where, line))
        exclude = line.startswith("-")
        host = line[1:] if exclude else line
        why = check_host(host)
        if why:
            raise CuratedError("%s: invalid host %r: %s" % (where, host, why))
        if exclude:
            if section == "never":
                raise CuratedError("%s: exclusion %r in [never] (exclusions belong to [ads] / [trackers])" % (where, line))
            key = (section, host)
            if key in seen_excl:
                raise CuratedError("%s: duplicate exclusion %r (first on line %d)" % (where, host, seen_excl[key]))
            seen_excl[key] = n
            excl_lines[key] = n
            out[section]["exclusions"].append(host)
            continue
        # A host listed in both [never] and a blocked section is reported by never_conflicts().
        key = host if section != "never" else ("never", host)
        if key in seen_hosts:
            first_n, first_s = seen_hosts[key]
            raise CuratedError("%s: duplicate host %r (first on line %d in [%s])" % (where, host, first_n, first_s))
        seen_hosts[key] = (n, section)
        if section == "never":
            out["never"].append(host)
        else:
            out[section]["hosts"].append(host)
    for s in BLOCK_SECTIONS:
        if s not in seen_sections:
            raise CuratedError("%s: section [%s] missing" % (SOURCE, s))
        if not out[s]["hosts"]:
            raise CuratedError("%s: section [%s] has no hosts" % (SOURCE, s))
        for e in out[s]["exclusions"]:
            if not any(_covers(h, e) and h != e for h in out[s]["hosts"]):
                raise CuratedError("%s line %d: exclusion -%s excludes nothing: it is not a subdomain of a "
                                   "host blocked in [%s]" % (SOURCE, excl_lines[(s, e)], e, s))
        out[s]["hosts"].sort()
        out[s]["exclusions"].sort()
    out["never"].sort()
    return out


def never_conflicts(parsed):
    """[(never host, section, blocking host)] for every [never] host that a curated rule would
    block: equal to or under a blocked host of a section and not under an exclusion of it."""
    bad = []
    for n in parsed["never"]:
        for s in BLOCK_SECTIONS:
            if any(_covers(e, n) for e in parsed[s]["exclusions"]):
                continue
            for h in parsed[s]["hosts"]:
                if _covers(h, n):
                    bad.append((n, s, h))
    return bad


def section_rule(sec):
    cond = {"requestDomains": list(sec["hosts"]), "domainType": "thirdParty"}
    if sec["exclusions"]:
        cond["excludedRequestDomains"] = list(sec["exclusions"])
    return {"id": RULE_ID, "priority": PRIORITY, "action": {"type": "block"}, "condition": cond}


def curated_info(parsed):
    info = {"source": SOURCE, "never": len(parsed["never"])}
    for s in BLOCK_SECTIONS:
        info[s] = {"hosts": len(parsed[s]["hosts"]), "exclusions": len(parsed[s]["exclusions"])}
    return info


def build_curated(text):
    """Parse and check the list. Returns ({ruleset id: [rule]}, build-info entry).
    Raises CuratedError, also when a [never] host would be blocked."""
    parsed = parse_curated(text)
    bad = never_conflicts(parsed)
    if bad:
        raise CuratedError("%s: [never] hosts would be blocked: %s. Remove the blocked host or add an "
                           "exclusion (-host) to that section." % (
                               SOURCE, "; ".join("%s by %s in [%s]" % (n, h, s) for n, s, h in bad)))
    rules = {rid: [section_rule(parsed[s])] for s, rid in RULESETS}
    return rules, curated_info(parsed)
