"""Adblock-style filter list -> Chrome declarativeNetRequest (DNR) rules and cosmetic data.

Written from scratch for this project (MIT, see LICENSE). It follows the public Adblock Plus
filter syntax (https://help.adblockplus.org/hc/en-us/articles/360062733293) and the public DNR
rule format (https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest).
No code from uBlock Origin Lite or AdGuard is used.

Only what DNR can express is converted:
  network filters   pattern with `||`, `|`, `^`, `*`; options `third-party`/`first-party`,
                    resource types (and `~type`), `domain=` (-> initiatorDomains /
                    excludedInitiatorDomains), `match-case`, `important`; `@@` exceptions become
                    allow rules with a higher priority (`@@...$document` -> allowAllRequests);
                    a few simple `/regex/` filters (RE2-safe subset, capped).
  cosmetic filters  `##selector` and `domain##selector`, `#@#` exceptions, `$generichide` and
                    `$elemhide` exceptions for plain `||host^` patterns.
Everything else is skipped and counted by reason (popup filters, redirect/csp/removeparam/...
options, procedural and scriptlet cosmetic filters, wildcard-TLD domains, ...).

Pure functions only (no I/O); tools/build_rules.py does the downloading and writing.
"""
import json
import re

PRIORITY_BLOCK = 1
PRIORITY_ALLOW = 2
PRIORITY_IMPORTANT = 3
PRIORITY_ALLOW_IMPORTANT = 4
# Rule ids of allow / allowAllRequests rules start here (block and modifyHeaders rules are
# below it), so the popup can tell "blocked" matches from "allowed" ones by id alone.
ALLOW_ID_BASE = 500000
MAX_RULES_PER_RULESET = 30000
DOMAINS_PER_RULE = 1000
MAX_REGEX_RULES_PER_LIST = 200

TYPE_MAP = {
    "script": "script", "image": "image", "stylesheet": "stylesheet", "css": "stylesheet",
    "object": "object", "xmlhttprequest": "xmlhttprequest", "xhr": "xmlhttprequest",
    "subdocument": "sub_frame", "frame": "sub_frame", "ping": "ping", "beacon": "ping",
    "media": "media", "font": "font", "websocket": "websocket", "other": "other",
    "document": "main_frame", "doc": "main_frame",
}
ALL_RESOURCE_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
    "webbundle", "other",
]
COSMETIC_ONLY_OPTIONS = {"generichide", "ghide", "elemhide", "ehide", "specifichide", "shide"}
# Options we know but DNR cannot express (or that would change the filter's meaning if dropped).
UNSUPPORTED_OPTIONS = {
    "redirect", "redirect-rule", "rewrite", "csp", "removeparam", "queryprune", "header",
    "replace", "badfilter", "sitekey", "empty", "mp4", "inline-script", "inline-font", "cname",
    "denyallow", "to", "method", "permissions", "urltransform", "uritransform", "all",
    "strict1p", "strict3p", "popunder", "webrtc", "object-subrequest", "genericblock",
    "urlskip", "reason", "ipaddress", "responseheader", "requestheader",
}
PROCEDURAL_MARKERS = (
    ":-abp-", ":has-text(", ":contains(", ":xpath(", ":upward(", ":remove(", ":style(",
    ":matches-css", ":min-text-length(", ":watch-attr(", ":others(", ":matches-path(",
    ":matches-attr(", ":matches-prop(", ":if(", ":if-not(", ":nth-ancestor(", ":remove-attr(",
    ":remove-class(", ":matches-media(", ":shadow", ":-ext-",
)
_OPTION_TOKEN = r"~?[A-Za-z0-9_-]+(?:=[^,]*)?"
_OPTIONS_RE = re.compile(r"^%s(?:,%s)*$" % (_OPTION_TOKEN, _OPTION_TOKEN))
_HOST_RE = re.compile(r"^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$")
_PLAIN_DOMAIN_RE = re.compile(r"^\|\|([a-z0-9_.-]+)\^$")
_COSMETIC_RE = re.compile(r"^([^#]*)(#@?(?:\$\?|[?$%])?#)(.*)$")


class Skip(Exception):
    """A filter we cannot (or do not) convert; str() is the reason used for counting."""


def to_ascii_host(host):
    """Lowercase, punycode-encode a host name. Raises Skip if it is not a valid host."""
    h = host.strip().lower().rstrip(".")
    if not h:
        raise Skip("empty-domain")
    if not h.isascii():
        try:
            h = h.encode("idna").decode("ascii")
        except UnicodeError:
            raise Skip("bad-domain")
    if not _HOST_RE.match(h):
        raise Skip("bad-domain")
    return h


def parse_domain_list(value, sep):
    """`a.com|~b.com` -> (included, excluded). Wildcard (`a.*`) and regex entries: an included one
    is dropped (narrows the filter, safe); an excluded one makes the whole filter unconvertible."""
    inc, exc = [], []
    dropped = False
    for part in value.split(sep):
        part = part.strip()
        if not part:
            continue
        neg = part.startswith("~")
        name = part[1:] if neg else part
        if "*" in name or name.startswith("/"):
            if neg:
                raise Skip("wildcard-domain")
            dropped = True
            continue
        host = to_ascii_host(name)
        (exc if neg else inc).append(host)
    if dropped and not inc:
        raise Skip("wildcard-domain")
    return sorted(set(inc)), sorted(set(exc))


def classify(line):
    """Returns ('comment', None) | ('cosmetic', (domains, marker, selector)) | ('network', text)."""
    s = line.strip()
    if not s or s.startswith("!") or (s.startswith("[") and s.endswith("]")):
        return "comment", None
    m = _COSMETIC_RE.match(s)
    if m and not s.startswith("@@") and "/" not in m.group(1) and "$" not in m.group(1):
        return "cosmetic", (m.group(1), m.group(2), m.group(3))
    return "network", s


def split_options(text):
    """Split `pattern$options`. A `$` inside a regex pattern is not an option separator."""
    i = text.rfind("$")
    if i <= 0 and not text.startswith("$"):
        return text, ""
    cand = text[i + 1:]
    if cand and _OPTIONS_RE.match(cand) and not (text.startswith("/") and cand.endswith("/")):
        return text[:i], cand
    return text, ""


def is_re2_safe(rx):
    """Conservative check that a JS regex body is RE2-compatible and small once compiled."""
    if not rx or len(rx) > 200 or not rx.isascii():
        return False
    for bad in ("(?=", "(?!", "(?<", "(?>", "(?P"):
        if bad in rx:
            return False
    if re.search(r"\\[1-9]", rx):
        return False
    for m in re.finditer(r"\{(\d+)(?:,(\d*))?\}", rx):
        if int(m.group(1)) > 20 or (m.group(2) and int(m.group(2)) > 20):
            return False
    try:
        re.compile(rx)
    except re.error:
        return False
    return True


def parse_network(text):
    """Parse one network filter. Returns a dict describing the rule, or raises Skip.

    Result keys: allow, cosmetic_exception (set of option names, for $generichide/$elemhide),
    action ('block'|'allow'|'allowAllRequests'), priority, condition (DNR condition dict),
    plain_domain (host when the pattern is exactly ||host^, else None).
    """
    allow = text.startswith("@@")
    body = text[2:] if allow else text
    pattern, opts = split_options(body)
    if " " in pattern or "\t" in pattern:
        raise Skip("whitespace")
    cond = {}
    domain_type = None
    types, excl_types = set(), set()
    has_popup = False
    match_case = False
    important = False
    cosmetic = set()
    for raw in (opts.split(",") if opts else []):
        raw = raw.strip()
        if not raw:
            continue
        name, _, value = raw.partition("=")
        name = name.lower()
        neg = name.startswith("~")
        base = name[1:] if neg else name
        if base in ("third-party", "3p"):
            domain_type = "firstParty" if neg else "thirdParty"
        elif base in ("first-party", "1p"):
            domain_type = "thirdParty" if neg else "firstParty"
        elif base in TYPE_MAP and not value:
            (excl_types if neg else types).add(TYPE_MAP[base])
        elif base == "popup" and not neg:
            has_popup = True
        elif base == "popup":
            continue  # ~popup: every other type, which is the default anyway
        elif base in ("domain", "from") and not neg:
            if not value:
                raise Skip("bad-option")
            inc, exc = parse_domain_list(value, "|")
            if inc:
                cond["initiatorDomains"] = inc
            if exc:
                cond["excludedInitiatorDomains"] = exc
        elif base == "match-case" and not neg:
            match_case = True
        elif base == "important" and not neg:
            important = True
        elif base in COSMETIC_ONLY_OPTIONS and not neg:
            cosmetic.add({"ghide": "generichide", "ehide": "elemhide", "shide": "specifichide"}.get(base, base))
        elif base in UNSUPPORTED_OPTIONS:
            raise Skip("option:" + base)
        else:
            raise Skip("option:unknown")

    if cosmetic:
        if not allow:
            raise Skip("cosmetic-option-on-block")
        m = _PLAIN_DOMAIN_RE.match(pattern.lower())
        if not m or types or cond:
            raise Skip("cosmetic-exception-pattern")
        return {"allow": True, "cosmetic_exception": cosmetic, "host": to_ascii_host(m.group(1))}

    if has_popup and not types:
        raise Skip("popup")
    if "main_frame" in types and not allow and len(types) > 1:
        types.discard("main_frame")  # keep the subresource part; page blocking is not done
    if not allow and types == {"main_frame"}:
        raise Skip("document-block")

    action = "allow" if allow else "block"
    if allow and "main_frame" in types:
        action = "allowAllRequests"
        types = {"main_frame", "sub_frame"}
        excl_types = set()

    plain = None
    if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
        rx = pattern[1:-1]
        if not is_re2_safe(rx):
            raise Skip("regex")
        cond["regexFilter"] = rx
    else:
        p = pattern
        if not p.isascii():
            raise Skip("non-ascii")
        if p.startswith("||*"):
            p = "*" + p[3:]
        while p.startswith("**"):
            p = p[1:]
        inner = p[2:] if p.startswith("||") else p[1:] if p.startswith("|") else p
        inner = inner[:-1] if inner.endswith("|") else inner
        if "|" in inner:
            raise Skip("pipe-in-pattern")
        if p in ("", "*", "|", "||", "|*", "*|"):
            if not cond.get("initiatorDomains"):
                raise Skip("too-broad")
        else:
            if len(p.strip("*|^")) < 3 and not cond.get("initiatorDomains"):
                raise Skip("too-broad")
            m = _PLAIN_DOMAIN_RE.match(p.lower())
            if m and not match_case:
                try:
                    plain = to_ascii_host(m.group(1))
                except Skip:
                    plain = None
            if plain is None:
                cond["urlFilter"] = p
    if match_case:
        cond["isUrlFilterCaseSensitive"] = True
    if domain_type:
        cond["domainType"] = domain_type
    if types:
        cond["resourceTypes"] = sorted(types)
    elif excl_types:
        cond["excludedResourceTypes"] = sorted(excl_types)
    if allow:
        priority = PRIORITY_ALLOW_IMPORTANT if important else PRIORITY_ALLOW
    else:
        priority = PRIORITY_IMPORTANT if important else PRIORITY_BLOCK
    return {"allow": allow, "cosmetic_exception": None, "action": action, "priority": priority,
            "condition": cond, "plain_domain": plain}


def _remove_covered(domains):
    """Drop hosts whose parent domain is also in the set (||a.b^ is covered by ||b^)."""
    s = set(domains)
    out = []
    for d in sorted(s):
        parts = d.split(".")
        if any(".".join(parts[i:]) in s for i in range(1, len(parts))):
            continue
        out.append(d)
    return out


def build_network_rules(parsed, max_regex=MAX_REGEX_RULES_PER_LIST):
    """Turn parsed filters into DNR rules. Plain `||host^` filters with identical options are
    merged into one rule with `requestDomains` (DOMAINS_PER_RULE hosts each).
    Returns (rules, stats) where stats counts merged domains and regex rules."""
    groups = {}
    singles = []
    seen = set()
    regex_count = 0
    stats = {"merged-domains": 0, "regex": 0, "duplicates": 0, "regex-cap": 0}
    for p in parsed:
        if p.get("cosmetic_exception"):
            continue
        cond = p["condition"]
        if p["plain_domain"]:
            key = json.dumps([p["action"], p["priority"], cond], sort_keys=True)
            groups.setdefault(key, (p["action"], p["priority"], cond, []))[3].append(p["plain_domain"])
            continue
        key = json.dumps([p["action"], p["priority"], cond], sort_keys=True)
        if key in seen:
            stats["duplicates"] += 1
            continue
        if "regexFilter" in cond:
            if regex_count >= max_regex:
                stats["regex-cap"] += 1
                continue
            regex_count += 1
        seen.add(key)
        singles.append((p["action"], p["priority"], cond))
    stats["regex"] = regex_count
    block, allow = [], []
    for key in sorted(groups):
        action, priority, cond, domains = groups[key]
        doms = _remove_covered(domains)
        stats["merged-domains"] += len(doms)
        for i in range(0, len(doms), DOMAINS_PER_RULE):
            c = dict(cond)
            c["requestDomains"] = doms[i:i + DOMAINS_PER_RULE]
            (allow if action != "block" else block).append((action, priority, c))
    for action, priority, cond in singles:
        (allow if action != "block" else block).append((action, priority, cond))
    rules = []
    for i, (action, priority, cond) in enumerate(block):
        rules.append({"id": i + 1, "priority": priority, "action": {"type": action}, "condition": cond})
    for i, (action, priority, cond) in enumerate(allow):
        rules.append({"id": ALLOW_ID_BASE + i + 1, "priority": priority, "action": {"type": action}, "condition": cond})
    return rules, stats


def split_rulesets(rules, limit=MAX_RULES_PER_RULESET):
    """Split a rule list into chunks of at most `limit` rules (ids stay unique per chunk)."""
    return [rules[i:i + limit] for i in range(0, len(rules), limit)] or [[]]


def cookie_strip_rules(domains, cap):
    """modifyHeaders rules removing Cookie (request) and Set-Cookie (response) for third-party
    requests to the given hosts (first `cap` hosts, order kept)."""
    seen, picked = set(), []
    for d in domains:
        if d not in seen:
            seen.add(d)
            picked.append(d)
    picked = _remove_covered(picked[:cap])
    rules = []
    for i in range(0, len(picked), DOMAINS_PER_RULE):
        rules.append({
            "id": len(rules) + 1,
            "priority": PRIORITY_BLOCK,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [{"header": "cookie", "operation": "remove"}],
                "responseHeaders": [{"header": "set-cookie", "operation": "remove"}],
            },
            "condition": {"requestDomains": picked[i:i + DOMAINS_PER_RULE], "domainType": "thirdParty"},
        })
    return rules, len(picked)


def is_tracker_cookie_domain(text):
    """True for EasyPrivacy filters of exactly the form ||host^$third-party."""
    m = re.match(r"^\|\|([a-z0-9_.-]+)\^\$third-party$", text.strip().lower())
    return m.group(1) if m else None


def parse_cosmetic(domains, marker, selector):
    """Returns (exception, included_hosts, excluded_hosts, selector) or raises Skip."""
    if marker not in ("##", "#@#"):
        raise Skip("procedural-or-scriptlet")
    sel = selector.strip()
    if not sel:
        raise Skip("empty-selector")
    if sel.startswith("+js(") or sel.startswith("^"):
        raise Skip("procedural-or-scriptlet")
    low = sel.lower()
    if any(mk in low for mk in PROCEDURAL_MARKERS):
        raise Skip("procedural-or-scriptlet")
    if "\n" in sel or "\r" in sel or not _balanced(sel):
        raise Skip("bad-selector")
    inc, exc = parse_domain_list(domains, ",") if domains.strip() else ([], [])
    return marker == "#@#", inc, exc, sel


def _balanced(sel):
    """Brackets and quotes balanced; no `{`, `}` or `;` outside quotes (would end the CSS rule)."""
    depth = {"(": 0, "[": 0}
    quote = None
    esc = False
    for ch in sel:
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch in "{};":
            return False
        elif ch in "([":
            depth[ch] += 1
        elif ch == ")":
            depth["("] -= 1
        elif ch == "]":
            depth["["] -= 1
        if depth["("] < 0 or depth["["] < 0:
            return False
    return quote is None and depth["("] == 0 and depth["["] == 0


class CosmeticCollector:
    """Collects cosmetic filters of one category ('ads' or 'cookies')."""

    def __init__(self):
        self.generic = []          # selectors, list order kept
        self._generic_set = set()
        self.site = {}             # host -> [selectors]
        self.exceptions = {}       # host -> set(selectors)  (#@# and ~host negations)
        self.global_exceptions = set()

    def add(self, exception, inc, exc, sel):
        if exception:
            if not inc:
                self.global_exceptions.add(sel)
            for h in inc:
                self.exceptions.setdefault(h, set()).add(sel)
            return
        for h in exc:
            self.exceptions.setdefault(h, set()).add(sel)
        if not inc:
            if sel not in self._generic_set:
                self._generic_set.add(sel)
                self.generic.append(sel)
            return
        for h in inc:
            lst = self.site.setdefault(h, [])
            if sel not in lst:
                lst.append(sel)

    def finish(self):
        self.generic = [s for s in self.generic if s not in self.global_exceptions]
        self._generic_set = set(self.generic)


_SIMPLE_SELECTOR_RE = re.compile(r"^[#.]-?[A-Za-z_][A-Za-z0-9_-]*$")
CSS_GROUP = 100


def generic_css(selectors):
    """CSS hiding rules. Plain `#id` / `.class` selectors that are certainly valid are grouped
    CSS_GROUP per rule; every other selector gets its own rule, so an invalid one only drops
    itself (one bad selector in a list would drop the whole rule)."""
    simple = [s for s in selectors if _SIMPLE_SELECTOR_RE.match(s)]
    other = [s for s in selectors if not _SIMPLE_SELECTOR_RE.match(s)]
    out = []
    for i in range(0, len(simple), CSS_GROUP):
        out.append("%s{display:none!important}\n" % ",".join(simple[i:i + CSS_GROUP]))
    out.extend("%s{display:none!important}\n" % s for s in other)
    return "".join(out)


def host_patterns(host):
    """Match patterns covering a host and its subdomains (http and https)."""
    return ["*://*.%s/*" % host]
