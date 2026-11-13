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
    if at == "redirect" and not isinstance(action.get("redirect"), dict):
        e.append("redirect action needs redirect")

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
