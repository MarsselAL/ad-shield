"""Offline checker for Chrome declarativeNetRequest static rules (written for this project).

Follows https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest:
rule shape and types, the documented constraints (ASCII-only filters, no `||*` prefix,
non-empty domain lists, punycode hosts, allowAllRequests only for main_frame/sub_frame, header
operations) and the static limits used by tests/validate_manifest.py and tests/test_rules.py.
Independent of tools/filterlist.py on purpose, so it checks the converter instead of trusting it.
"""
import re

GUARANTEED_MINIMUM_STATIC_RULES = 30000
MAX_NUMBER_OF_REGEX_RULES = 1000
MAX_NUMBER_OF_STATIC_RULESETS = 100
MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50
REGEX_MAX_LENGTH = 2000  # proxy for "less than 2KB once compiled"; ours are far smaller
ALLOW_ID_BASE = 500000  # tools/filterlist.py: block rule ids are below it, allow rule ids above
# Rulesets built from our own rules/curated_hosts.txt (tools/curated.py), in manifest order.
CURATED_RULESETS = ("ads_curated", "privacy_curated")
# Every general (non-Twitch) ruleset id the build may produce.
GENERATED_RULESET_RE = re.compile(
    r"^(ads|privacy|cookies)_\d+$|^(ads|privacy)_(curated|surrogates)$|^cookie_strip$|^youtube$|^removeparam$|^gpc$|^unwrap$")
_ORDER_GROUPS = {"ads": 0, "privacy": 1, "cookies": 2, "cookie_strip": 3, "youtube": 4, "removeparam": 5, "gpc": 6,
                 "ads_surrogates": 7, "privacy_surrogates": 8, "unwrap": 9}
# Hand-written surrogate redirect rulesets (rules/ads_surrogates.json, rules/privacy_surrogates.json).
SURROGATE_RULESETS = ("ads_surrogates", "privacy_surrogates")
SURROGATE_DIR = "/src/surrogates/"
# Hand-written Global Privacy Control ruleset (rules/gpc.json).
GPC_RULESET = "gpc"
# Link-unwrapping redirects (rules/unwrap.json from rules/unwrap.txt, tools/unwrap.py).
UNWRAP_RULESET = "unwrap"
# The only ruleset allowed to contain redirect rules (tools/removeparam.py).
REMOVEPARAM_RULESET = "removeparam"
ALLOWLIST_PRIORITY = 100  # src/shared/blocking.js: the per-site allowlist rule must outrank everything
PARAM_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

RESOURCE_TYPES = {
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other",
}
ACTION_TYPES = {"block", "redirect", "allow", "upgradeScheme", "modifyHeaders", "allowAllRequests"}
DOMAIN_LIST_KEYS = ("initiatorDomains", "excludedInitiatorDomains", "requestDomains", "excludedRequestDomains")
CONDITION_KEYS = set(DOMAIN_LIST_KEYS) | {
    "urlFilter", "regexFilter", "isUrlFilterCaseSensitive", "resourceTypes", "excludedResourceTypes",
    "domainType", "requestMethods", "excludedRequestMethods", "tabIds", "excludedTabIds",
}
HEADER_OPS = {"append", "set", "remove"}
HOST_RE = re.compile(r"^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$")


def rule_errors(rule):
    """List of problems with one rule (empty list = valid)."""
    e = []
    if not isinstance(rule, dict):
        return ["rule is not an object"]
    extra = set(rule) - {"id", "priority", "action", "condition"}
    if extra:
        e.append("unknown rule keys %s" % sorted(extra))
    rid = rule.get("id")
    if not isinstance(rid, int) or isinstance(rid, bool) or rid < 1:
        e.append("id must be an integer >= 1")
    pr = rule.get("priority", 1)
    if not isinstance(pr, int) or isinstance(pr, bool) or pr < 1:
        e.append("priority must be an integer >= 1")
    action = rule.get("action")
    cond = rule.get("condition")
    if not isinstance(action, dict) or action.get("type") not in ACTION_TYPES:
        e.append("bad action")
        return e
    if not isinstance(cond, dict):
        e.append("condition must be an object")
        return e
    at = action["type"]
    if at in ("block", "allow", "allowAllRequests", "upgradeScheme") and set(action) != {"type"}:
        e.append("%s action takes no other keys" % at)
    if at == "modifyHeaders":
        if set(action) - {"type", "requestHeaders", "responseHeaders"}:
            e.append("unknown modifyHeaders keys")
        lists = [action.get("requestHeaders"), action.get("responseHeaders")]
        if not any(isinstance(x, list) and x for x in lists):
            e.append("modifyHeaders needs requestHeaders or responseHeaders")
        for lst in lists:
            if lst is None:
                continue
            if not isinstance(lst, list) or not lst:
                e.append("header list must be a non-empty list")
                continue
            for h in lst:
                if not isinstance(h, dict) or not isinstance(h.get("header"), str) or not h["header"]:
                    e.append("bad header entry")
                    continue
                op = h.get("operation")
                if op not in HEADER_OPS:
                    e.append("bad header operation %r" % op)
                if op == "remove" and "value" in h:
                    e.append("remove takes no value")
                if op in ("set", "append") and not isinstance(h.get("value"), str):
                    e.append("%s needs a value" % op)
    if at == "redirect":
        red = action.get("redirect")
        if set(action) != {"type", "redirect"} or not isinstance(red, dict):
            e.append("redirect action needs redirect")
        elif len(set(red) & {"url", "extensionPath", "transform", "regexSubstitution"}) != 1 or set(red) - {
                "url", "extensionPath", "transform", "regexSubstitution"}:
            e.append("redirect needs exactly one of url, extensionPath, transform, regexSubstitution")

    extra = set(cond) - CONDITION_KEYS
    if extra:
        e.append("unknown condition keys %s" % sorted(extra))
    if "urlFilter" in cond and "regexFilter" in cond:
        e.append("urlFilter and regexFilter are exclusive")
    uf = cond.get("urlFilter")
    if uf is not None:
        if not isinstance(uf, str) or not uf:
            e.append("urlFilter must be a non-empty string")
        elif not uf.isascii():
            e.append("urlFilter must be ASCII")
        elif uf.startswith("||*"):
            e.append("urlFilter must not start with ||*")
    rx = cond.get("regexFilter")
    if rx is not None:
        if not isinstance(rx, str) or not rx or not rx.isascii():
            e.append("regexFilter must be a non-empty ASCII string")
        elif len(rx) > REGEX_MAX_LENGTH:
            e.append("regexFilter too long")
        else:
            for bad in ("(?=", "(?!", "(?<=", "(?<!"):
                if bad in rx:
                    e.append("regexFilter uses lookaround (not RE2)")
            if re.search(r"\\[1-9]", rx):
                e.append("regexFilter uses a backreference (not RE2)")
            try:
                re.compile(rx)
            except re.error as ex:
                e.append("regexFilter does not compile: %s" % ex)
    if "isUrlFilterCaseSensitive" in cond and not isinstance(cond["isUrlFilterCaseSensitive"], bool):
        e.append("isUrlFilterCaseSensitive must be a boolean")
    for k in DOMAIN_LIST_KEYS:
        if k not in cond:
            continue
        v = cond[k]
        if not isinstance(v, list) or not v:
            e.append("%s must be a non-empty list" % k)
            continue
        for d in v:
            if not isinstance(d, str) or not d.isascii() or d != d.lower() or not HOST_RE.match(d):
                e.append("%s: bad host %r" % (k, d))
        if len(set(v)) != len(v):
            e.append("%s has duplicates" % k)
    if "resourceTypes" in cond and "excludedResourceTypes" in cond:
        e.append("resourceTypes and excludedResourceTypes are exclusive")
    for k in ("resourceTypes", "excludedResourceTypes"):
        if k in cond:
            v = cond[k]
            if not isinstance(v, list) or not v or any(t not in RESOURCE_TYPES for t in v):
                e.append("%s: bad value %r" % (k, v))
    if at == "allowAllRequests":
        rt = cond.get("resourceTypes")
        if not rt or any(t not in ("main_frame", "sub_frame") for t in rt):
            e.append("allowAllRequests needs resourceTypes within main_frame/sub_frame")
    if "domainType" in cond and cond["domainType"] not in ("firstParty", "thirdParty"):
        e.append("bad domainType")
    return e


def ruleset_errors(rules, name="ruleset"):
    """Problems with a whole ruleset (list of rules); also checks unique ids."""
    if not isinstance(rules, list):
        return ["%s is not a list" % name]
    out = []
    ids = set()
    for r in rules:
        for msg in rule_errors(r):
            out.append("%s rule %s: %s" % (name, r.get("id") if isinstance(r, dict) else "?", msg))
        if isinstance(r, dict):
            if r.get("id") in ids:
                out.append("%s: duplicate id %s" % (name, r.get("id")))
            ids.add(r.get("id"))
    if len(rules) > GUARANTEED_MINIMUM_STATIC_RULES:
        out.append("%s has %d rules (> %d)" % (name, len(rules), GUARANTEED_MINIMUM_STATIC_RULES))
    return out


def regex_count(rules):
    return sum(1 for r in rules if isinstance(r, dict) and "regexFilter" in r.get("condition", {}))


def general_order_key(rid):
    """Required manifest order of the general rulesets: ads_1.., ads_curated, privacy_1..,
    privacy_curated, cookies_1.., cookie_strip, youtube (hand-written), removeparam, gpc,
    ads_surrogates, privacy_surrogates (hand-written)."""
    if rid in _ORDER_GROUPS:
        return (_ORDER_GROUPS[rid], 0)
    prefix, _, rest = rid.rpartition("_")
    return (_ORDER_GROUPS.get(prefix, 9), 10 ** 9 if rest == "curated" else int(rest) if rest.isdigit() else -1)


def _under(host, parents):
    return any(host != p and host.endswith("." + p) for p in parents)


def curated_ruleset_errors(rules, name="curated ruleset"):
    """Problems with a curated ruleset: exactly one third-party block rule on requestDomains,
    priority 1, a block-range id, optional excludedRequestDomains (each under a blocked host),
    and no resource types, so main_frame (top-level navigation) is never blocked."""
    if not isinstance(rules, list) or len(rules) != 1 or not isinstance(rules[0], dict):
        return ["%s must hold exactly one rule" % name]
    r = rules[0]
    e = ["%s: %s" % (name, m) for m in rule_errors(r)]
    if set(r) != {"id", "priority", "action", "condition"}:
        e.append("%s: rule keys must be id, priority, action, condition" % name)
    rid = r.get("id")
    if not isinstance(rid, int) or isinstance(rid, bool) or not 1 <= rid < ALLOW_ID_BASE:
        e.append("%s: id must be in the block range 1..%d" % (name, ALLOW_ID_BASE - 1))
    if r.get("priority") != 1:
        e.append("%s: priority must be 1" % name)
    if r.get("action") != {"type": "block"}:
        e.append("%s: action must be {type: block}" % name)
    c = r.get("condition")
    if not isinstance(c, dict):
        return e + ["%s: condition must be an object" % name]
    extra = set(c) - {"requestDomains", "domainType", "excludedRequestDomains"}
    if extra:
        e.append("%s: unexpected condition keys %s (no resourceTypes: main_frame must stay unblocked)" % (name, sorted(extra)))
    if c.get("domainType") != "thirdParty":
        e.append("%s: domainType must be thirdParty" % name)
    hosts = c.get("requestDomains")
    if not isinstance(hosts, list) or not hosts:
        e.append("%s: requestDomains must be a non-empty list" % name)
        hosts = []
    elif hosts != sorted(hosts):
        e.append("%s: requestDomains must be sorted" % name)
    for h in hosts:
        if isinstance(h, str) and "." not in h:
            e.append("%s: single-label host %r would block a whole TLD" % (name, h))
    if "excludedRequestDomains" in c:
        ex = c["excludedRequestDomains"]
        if not isinstance(ex, list) or not ex or ex != sorted(ex):
            e.append("%s: excludedRequestDomains must be a sorted non-empty list" % name)
        else:
            for x in ex:
                if not _under(x, hosts):
                    e.append("%s: excluded host %r is not under a blocked host" % (name, x))
    if "main_frame" in repr(r):
        e.append("%s: must not mention main_frame" % name)
    return e


def removeparam_ruleset_errors(rules, name="removeparam ruleset"):
    """Problems with rules/removeparam.json (tools/removeparam.py): every rule is a redirect whose
    only effect is queryTransform.removeParams (no added or replaced parameters), all rules remove
    the same names, each fires only on "?name=" / "&name=" of a name it removes (case-sensitive),
    main_frame / sub_frame only, priority above the list rules (1..4) and below the allowlist."""
    if not isinstance(rules, list) or not rules:
        return ["%s must be a non-empty list" % name]
    e = ruleset_errors(rules, name)
    first = None
    for r in rules:
        if not isinstance(r, dict):
            continue
        rid = r.get("id")
        where = "%s rule %s" % (name, rid)
        if set(r) != {"id", "priority", "action", "condition"}:
            e.append("%s: rule keys must be id, priority, action, condition" % where)
        if not isinstance(r.get("priority"), int) or not 4 < r["priority"] < ALLOWLIST_PRIORITY:
            e.append("%s: priority must be above 4 and below %d" % (where, ALLOWLIST_PRIORITY))
        a = r.get("action") or {}
        qt = (((a.get("redirect") or {}).get("transform") or {}).get("queryTransform") or {})
        if a.get("type") != "redirect" or set(a.get("redirect") or {}) != {"transform"} \
                or set(a["redirect"]["transform"]) != {"queryTransform"} or set(qt) != {"removeParams"}:
            e.append("%s: action must be redirect.transform.queryTransform.removeParams only" % where)
            continue
        params = qt["removeParams"]
        if not isinstance(params, list) or not params or len(set(params)) != len(params) \
                or not all(isinstance(p, str) and PARAM_RE.match(p) for p in params):
            e.append("%s: removeParams must be unique parameter names" % where)
            continue
        if first is None:
            first = params
        elif params != first:
            e.append("%s: every rule must remove the same names" % where)
        c = r.get("condition") or {}
        if set(c) - {"urlFilter", "isUrlFilterCaseSensitive", "resourceTypes", "excludedRequestDomains"}:
            e.append("%s: unexpected condition keys %s" % (where, sorted(set(c) - {
                "urlFilter", "isUrlFilterCaseSensitive", "resourceTypes", "excludedRequestDomains"})))
        if c.get("isUrlFilterCaseSensitive") is not True:
            e.append("%s: isUrlFilterCaseSensitive must be true (removeParams is case-sensitive)" % where)
        rt = c.get("resourceTypes")
        if not rt or any(t not in ("main_frame", "sub_frame") for t in rt):
            e.append("%s: resourceTypes must be within main_frame / sub_frame" % where)
        uf = c.get("urlFilter")
        m = re.match(r"^[?&]([A-Za-z0-9_]+)=$", uf) if isinstance(uf, str) else None
        if not m or m.group(1) not in params:
            e.append("%s: urlFilter must be ?name= or &name= of a removed name (else the redirect could loop)" % where)
    return e


GPC_HEADER = {"header": "Sec-GPC", "operation": "set", "value": "1"}


def gpc_ruleset_errors(rules, name="gpc ruleset"):
    """Problems with rules/gpc.json: exactly one modifyHeaders rule that only sets Sec-GPC: 1 on
    main_frame requests, with no other condition, priority above every list rule (1..4, so a list
    @@ exception does not stop it) and below the per-site allowlist (allowAllRequests, 100), which
    therefore turns it off on allowlisted sites. Main frame only: Chrome adds every modifyHeaders
    match to the toolbar badge count, so a rule on all requests would count every request."""
    if not isinstance(rules, list) or len(rules) != 1 or not isinstance(rules[0], dict):
        return ["%s must hold exactly one rule" % name]
    r = rules[0]
    e = ["%s: %s" % (name, m) for m in rule_errors(r)]
    if set(r) != {"id", "priority", "action", "condition"}:
        e.append("%s: rule keys must be id, priority, action, condition" % name)
    if not isinstance(r.get("id"), int) or not 1 <= r["id"] < ALLOW_ID_BASE:
        e.append("%s: id must be in the block range" % name)
    if not isinstance(r.get("priority"), int) or not 4 < r["priority"] < ALLOWLIST_PRIORITY:
        e.append("%s: priority must be above 4 and below %d" % (name, ALLOWLIST_PRIORITY))
    if r.get("action") != {"type": "modifyHeaders", "requestHeaders": [GPC_HEADER]}:
        e.append("%s: action must only set the request header Sec-GPC: 1" % name)
    if r.get("condition") != {"resourceTypes": ["main_frame"]}:
        e.append("%s: condition must be exactly resourceTypes [main_frame]" % name)
    return e


UNWRAP_HOST_GROUP = "([a-z0-9-]+(?:\\.[a-z0-9-]+)+"


def unwrap_ruleset_errors(rules, name="unwrap ruleset"):
    """Problems with rules/unwrap.json (tools/unwrap.py): every rule is a redirect.regexSubstitution
    to an https:// URL, on main_frame only, with a regexFilter anchored at ^https?:// and $.
    A substitution that starts with a group (https://\\1) must take group 1 from the host-name
    pattern, so the page always lands on https://<host name>. Priority above every list rule (1..4)
    and below the per-site allowlist (100), which therefore turns unwrapping off there."""
    if not isinstance(rules, list) or not rules:
        return ["%s must be a non-empty list" % name]
    e = ruleset_errors(rules, name)
    for r in rules:
        if not isinstance(r, dict):
            continue
        where = "%s rule %s" % (name, r.get("id"))
        if set(r) != {"id", "priority", "action", "condition"}:
            e.append("%s: rule keys must be id, priority, action, condition" % where)
        if not isinstance(r.get("id"), int) or not 1 <= r["id"] < ALLOW_ID_BASE:
            e.append("%s: id must be in the block range" % where)
        if not isinstance(r.get("priority"), int) or not 4 < r["priority"] < ALLOWLIST_PRIORITY:
            e.append("%s: priority must be above 4 and below %d" % (where, ALLOWLIST_PRIORITY))
        a = r.get("action") or {}
        sub = (a.get("redirect") or {}).get("regexSubstitution")
        if a.get("type") != "redirect" or set(a.get("redirect") or {}) != {"regexSubstitution"} or not isinstance(sub, str) \
                or not sub.startswith("https://"):
            e.append("%s: action must be redirect.regexSubstitution to https://..." % where)
            continue
        c = r.get("condition") or {}
        if set(c) - {"regexFilter", "resourceTypes", "excludedInitiatorDomains"} or "regexFilter" not in c:
            e.append("%s: condition must be regexFilter + resourceTypes (+ excludedInitiatorDomains)" % where)
        if c.get("resourceTypes") != ["main_frame"]:
            e.append("%s: resourceTypes must be [main_frame]" % where)
        rx = c.get("regexFilter")
        if not isinstance(rx, str) or not rx.startswith("^https?://") or not rx.endswith("$"):
            e.append("%s: regexFilter must start with ^https?:// and end with $" % where)
            continue
        if sub.startswith("https://\\"):
            first = re.search(r"(?<!\\)\((?!\?)", rx)
            if not sub.startswith("https://\\1") or not first or not rx.startswith(UNWRAP_HOST_GROUP, first.start()):
                e.append("%s: https://\\1 needs group 1 to start with the host pattern %s" % (where, UNWRAP_HOST_GROUP))
        elif not re.match(r"^https://[a-z0-9-]+(\.[a-z0-9-]+)+/", sub):
            e.append("%s: regexSubstitution must be https://<host>/... or https://\\1..." % where)
    return e


SURROGATE_PRIORITY = 2  # tools/filterlist.py: block rules 1, list exceptions (allow) 2


def surrogate_ruleset_errors(rules, name="surrogate ruleset", exists=None):
    """Problems with a surrogate ruleset: every rule redirects one script URL (urlFilter starting
    with ||, resourceTypes exactly [script], nothing else) to a .js file under /src/surrogates/
    (exists(path) checks it is there, when given). Priority exactly 2: above the list block rules
    (1), so the stand-in replaces a block; equal to the list exceptions (allow, 2), which win a tie
    over redirect, so a site the lists except still gets the real script; the allowlist (100) and
    $important blocks (3) also win."""
    if not isinstance(rules, list) or not rules:
        return ["%s must be a non-empty list" % name]
    e = ruleset_errors(rules, name)
    for r in rules:
        if not isinstance(r, dict):
            continue
        where = "%s rule %s" % (name, r.get("id"))
        if set(r) != {"id", "priority", "action", "condition"}:
            e.append("%s: rule keys must be id, priority, action, condition" % where)
        if not isinstance(r.get("id"), int) or not 1 <= r["id"] < ALLOW_ID_BASE:
            e.append("%s: id must be in the block range (counted like the block it replaces)" % where)
        if r.get("priority") != SURROGATE_PRIORITY:
            e.append("%s: priority must be %d" % (where, SURROGATE_PRIORITY))
        a = r.get("action") or {}
        path = (a.get("redirect") or {}).get("extensionPath")
        if a.get("type") != "redirect" or set(a.get("redirect") or {}) != {"extensionPath"} or not isinstance(path, str) \
                or not re.match(r"^/src/surrogates/[a-z0-9_-]+\.js$", path):
            e.append("%s: action must be redirect.extensionPath to %s<name>.js" % (where, SURROGATE_DIR))
        elif exists is not None and not exists(path):
            e.append("%s: %s does not exist" % (where, path))
        c = r.get("condition") or {}
        if set(c) != {"urlFilter", "resourceTypes"}:
            e.append("%s: condition must be exactly urlFilter + resourceTypes" % where)
        if c.get("resourceTypes") != ["script"]:
            e.append("%s: resourceTypes must be [script]" % where)
        uf = c.get("urlFilter")
        if not isinstance(uf, str) or not re.match(r"^\|\|[a-z0-9.-]+\.[a-z]+/", uf):
            e.append("%s: urlFilter must start with ||host/" % where)
    return e


# ---------------------------------------------------------------- tiny matcher (tests only)
def _url_filter_regex(pattern):
    """DNR urlFilter -> Python regex: || (domain anchor), | (start / end), * and ^ (separator or end)."""
    rx = ""
    if pattern.startswith("||"):
        rx, pattern = r"^[a-z][a-z0-9+.-]*://([^/?#]*\.)?", pattern[2:]
    elif pattern.startswith("|"):
        rx, pattern = "^", pattern[1:]
    end = ""
    if pattern.endswith("|"):
        end, pattern = "$", pattern[:-1]
    for ch in pattern:
        rx += ".*" if ch == "*" else r"(?:[^A-Za-z0-9_.%-]|$)" if ch == "^" else re.escape(ch)
    return rx + end


def _host_in(host, domains):
    return any(host == d or host.endswith("." + d) for d in domains)


def rule_matches(rule, url, resource_type, initiator_host=None):
    """Whether a static rule's condition matches a request (enough of DNR for our tests: domains,
    url / regex filters, resource types; domainType and request methods are ignored)."""
    c = rule.get("condition", {})
    host = re.match(r"^[a-z]+://([^/:?#]*)", url).group(1)
    if "requestDomains" in c and not _host_in(host, c["requestDomains"]):
        return False
    if "excludedRequestDomains" in c and _host_in(host, c["excludedRequestDomains"]):
        return False
    if "initiatorDomains" in c and not (initiator_host and _host_in(initiator_host, c["initiatorDomains"])):
        return False
    if "excludedInitiatorDomains" in c and initiator_host and _host_in(initiator_host, c["excludedInitiatorDomains"]):
        return False
    types = c.get("resourceTypes")
    if types is not None and resource_type not in types:
        return False
    if types is None and resource_type == "main_frame":
        return False
    if resource_type in c.get("excludedResourceTypes", []):
        return False
    flags = 0 if c.get("isUrlFilterCaseSensitive") else re.I
    if "urlFilter" in c and not re.search(_url_filter_regex(c["urlFilter"]), url, flags):
        return False
    if "regexFilter" in c and not re.search(c["regexFilter"], url, flags):
        return False
    return True
