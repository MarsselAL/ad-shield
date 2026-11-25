#!/usr/bin/env python3
"""Tests for the filter-list converter (tools/filterlist.py, tools/build_rules.py) and for the
generated data in rules/. Every generated DNR rule is checked against tests/dnr_schema.py.

Run with:  python3 -I tests/test_rules.py      (offline; prints "RESULT OK <n> passed")
"""
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import dnr_schema  # noqa: E402
import filterlist as F  # noqa: E402
import build_rules  # noqa: E402
import cosmetic as CO  # noqa: E402
import curated as C  # noqa: E402
import make_golden  # noqa: E402
import removeparam as R  # noqa: E402
import build  # noqa: E402


def rules_of(lines):
    parsed = [F.parse_network(l) for l in lines]
    return F.build_network_rules(parsed)[0]


def skip_reason(line):
    try:
        F.parse_network(line)
    except F.Skip as e:
        return str(e)
    return None


class NetworkFilters(unittest.TestCase):
    def test_plain_domains_merge_into_request_domains(self):
        rules = rules_of(["||a.com^", "||b.com^", "||x.a.com^", "||c.com^$third-party"])
        self.assertEqual(len(rules), 2)
        by = {json.dumps(r["condition"].get("domainType")): r for r in rules}
        self.assertEqual(by["null"]["condition"], {"requestDomains": ["a.com", "b.com"]})
        self.assertEqual(by['"thirdParty"']["condition"], {"domainType": "thirdParty", "requestDomains": ["c.com"]})
        self.assertTrue(all(r["action"] == {"type": "block"} and r["priority"] == 1 for r in rules))

    def test_merge_chunks_by_domains_per_rule(self):
        rules = rules_of(["||d%d.com^" % i for i in range(F.DOMAINS_PER_RULE + 5)])
        self.assertEqual([len(r["condition"]["requestDomains"]) for r in rules], [F.DOMAINS_PER_RULE, 5])

    def test_url_pattern_types_and_domains(self):
        r = rules_of(["/ads/banner.$image,script,domain=a.com|~b.a.com|c.com"])[0]
        self.assertEqual(r["condition"], {
            "urlFilter": "/ads/banner.", "resourceTypes": ["image", "script"],
            "initiatorDomains": ["a.com", "c.com"], "excludedInitiatorDomains": ["b.a.com"]})

    def test_negated_types_first_party_match_case(self):
        r = rules_of(["||ads.example.com/x^$~script,~third-party,match-case"])[0]["condition"]
        self.assertEqual(r["excludedResourceTypes"], ["script"])
        self.assertEqual(r["domainType"], "firstParty")
        self.assertIs(r["isUrlFilterCaseSensitive"], True)
        self.assertEqual(r["urlFilter"], "||ads.example.com/x^")

    def test_exception_becomes_higher_priority_allow_rule(self):
        rules = rules_of(["||ads.com^", "@@||ads.com/ok.js$script"])
        allow = [r for r in rules if r["action"]["type"] == "allow"][0]
        block = [r for r in rules if r["action"]["type"] == "block"][0]
        self.assertGreater(allow["priority"], block["priority"])
        self.assertGreaterEqual(allow["id"], F.ALLOW_ID_BASE)
        self.assertLess(block["id"], F.ALLOW_ID_BASE)

    def test_document_exception_is_allow_all_requests(self):
        r = rules_of(["@@||site.com^$document"])[0]
        self.assertEqual(r["action"], {"type": "allowAllRequests"})
        self.assertEqual(r["condition"], {"requestDomains": ["site.com"], "resourceTypes": ["main_frame", "sub_frame"]})

    def test_important(self):
        self.assertEqual(rules_of(["||t.com/a$important"])[0]["priority"], F.PRIORITY_IMPORTANT)

    def test_domain_anchor_with_wildcard_and_simple_regex(self):
        self.assertEqual(rules_of(["||*/ads/x"])[0]["condition"]["urlFilter"], "*/ads/x")
        r = rules_of([r"/^https?:\/\/[a-z]{8}\.com\/ad\//$script"])[0]
        self.assertEqual(r["condition"]["regexFilter"], r"^https?:\/\/[a-z]{8}\.com\/ad\/")
        self.assertEqual(r["condition"]["resourceTypes"], ["script"])

    def test_dollar_inside_regex_is_not_an_option_separator(self):
        self.assertEqual(rules_of(["/ad[0-9]+\\.js$/"])[0]["condition"]["regexFilter"], "ad[0-9]+\\.js$")

    def test_popup_mixed_keeps_other_types(self):
        self.assertEqual(rules_of(["||p.com/x$popup,script"])[0]["condition"]["resourceTypes"], ["script"])

    def test_skips_with_reasons(self):
        cases = {
            "||x.com^$popup": "popup",
            "||x.com^$document": "document-block",
            "||x.com^$csp=script-src 'none'": "option:csp",
            "||x.com/a.js$redirect=noop.js": "option:redirect",
            "||x.com^$removeparam=utm": "option:removeparam",
            "||x.com^$frobnicate": "option:unknown",
            "/ads/$domain=example.*": "wildcard-domain",
            "/ads/$domain=a.com|~example.*": "wildcard-domain",
            "/(?!good)ads/": "regex",
            r"/(https?:\/\/)104\.154\..{100,}/": "regex",
            # Chrome rejected these as over its 2 KB RE2 memory cap (ads_1 ids 2692, 3264, 3266).
            r"/^https?:\/\/.*\.(club|bid|biz|xyz)\/.*/": "regex",
            r"/^https?:\/\/.*\/[a-z0-9A-Z_]{2,15}\.(php|jx|jsx)/": "regex",
            "/a|b/x": "pipe-in-pattern",
            "/réclame.js": "non-ascii",
            "ad": "too-broad",
            "$third-party": "too-broad",
            "@@||x.com^$generichide,script": "cosmetic-exception-pattern",
            "||x.com^$generichide": "cosmetic-option-on-block",
        }
        for line, reason in cases.items():
            self.assertEqual(skip_reason(line), reason, line)

    def test_dropped_wildcard_entry_narrows_only(self):
        c = rules_of(["/ads/$domain=a.com|example.*"])[0]["condition"]
        self.assertEqual(c["initiatorDomains"], ["a.com"])

    def test_options_on_empty_pattern_with_domain(self):
        c = rules_of(["$script,third-party,domain=a.com"])[0]["condition"]
        self.assertNotIn("urlFilter", c)
        self.assertEqual(c["initiatorDomains"], ["a.com"])

    def test_generichide_exception(self):
        p = F.parse_network("@@||news.example^$generichide")
        self.assertEqual(p["cosmetic_exception"], {"generichide"})
        self.assertEqual(p["host"], "news.example")

    def test_idn_domains_are_punycoded(self):
        c = rules_of(["/ads/$domain=bücher.de"])[0]["condition"]
        self.assertEqual(c["initiatorDomains"], ["xn--bcher-kva.de"])

    def test_duplicates_dropped(self):
        rules, st = F.build_network_rules([F.parse_network("/ad.js"), F.parse_network("/ad.js")])
        self.assertEqual(len(rules), 1)
        self.assertEqual(st["duplicates"], 1)

    def test_split_rulesets(self):
        self.assertEqual([len(c) for c in F.split_rulesets(list(range(7)), 3)], [3, 3, 1])

    def test_cookie_strip_rules(self):
        self.assertEqual(F.is_tracker_cookie_domain("||trk.example^$third-party"), "trk.example")
        self.assertIsNone(F.is_tracker_cookie_domain("||trk.example^$script,third-party"))
        rules, n = F.cookie_strip_rules(["a.t", "b.t", "a.t", "x.a.t", "c.t"], 3)
        self.assertEqual(n, 2)  # first 3 unique: a.t, b.t, x.a.t; x.a.t is covered by a.t
        r = rules[0]
        self.assertEqual(r["action"]["type"], "modifyHeaders")
        self.assertEqual(r["action"]["requestHeaders"], [{"header": "cookie", "operation": "remove"}])
        self.assertEqual(r["action"]["responseHeaders"], [{"header": "set-cookie", "operation": "remove"}])
        self.assertEqual(r["condition"], {"requestDomains": ["a.t", "b.t"], "domainType": "thirdParty"})
        self.assertEqual(dnr_schema.ruleset_errors(rules), [])


class CosmeticFilters(unittest.TestCase):
    def parse(self, line):
        kind, val = F.classify(line)
        self.assertEqual(kind, "cosmetic", line)
        return F.parse_cosmetic(*val)

    def test_classify(self):
        self.assertEqual(F.classify("! comment")[0], "comment")
        self.assertEqual(F.classify("[Adblock Plus 2.0]")[0], "comment")
        self.assertEqual(F.classify("||x.com^")[0], "network")
        self.assertEqual(F.classify("||x.com/#ad")[0], "network")

    def test_generic_site_exception(self):
        self.assertEqual(self.parse("##.ad-box"), (False, [], [], ".ad-box"))
        self.assertEqual(self.parse("a.com,~b.a.com##div[style=\"a;b\"]"), (False, ["a.com"], ["b.a.com"], 'div[style="a;b"]'))
        self.assertEqual(self.parse("a.com#@#.ad-box"), (True, ["a.com"], [], ".ad-box"))

    def test_skipped(self):
        for line in ("a.com#?#.x:has-text(Ad)", "a.com##+js(nobab)", "a.com#$#abort-on-property-read x",
                     "##.x:-abp-has(.y)", "##div{color:red}", "##.x[", "a.com#%#window.x=1", "a.com##^script"):
            kind, val = F.classify(line)
            with self.assertRaises(F.Skip, msg=line):
                F.parse_cosmetic(*val)

    def test_collector(self):
        c = F.CosmeticCollector()
        c.add(*self.parse("##.ad"))
        c.add(*self.parse("##.gone"))
        c.add(*self.parse("#@#.gone"))
        c.add(*self.parse("~skip.com##.neg"))
        c.add(*self.parse("a.com##.site"))
        c.add(*self.parse("a.com#@#.ad"))
        c.finish()
        self.assertEqual(c.generic, [".ad", ".neg"])
        self.assertEqual(c.site, {"a.com": [".site"]})
        self.assertEqual(c.exceptions, {"a.com": {".ad"}, "skip.com": {".neg"}})

    def test_generic_css_groups_only_safe_selectors(self):
        css = F.generic_css([".a", "#b", ".1bad", "div > .c"])
        lines = css.strip().split("\n")
        self.assertEqual(lines[0], ".a,#b{display:none!important}")
        self.assertIn(".1bad{display:none!important}", lines)
        self.assertIn("div > .c{display:none!important}", lines)


def curated(text):
    return C.build_curated(text)


class CuratedHosts(unittest.TestCase):
    BASIC = "[ads]\n# c\nb.ads.com\n\na.ads.com\n[trackers]\nquantcast.com\n-cmp.quantcast.com\nt.example\n[never]\ncmp.quantcast.com\ncdn.example\n"

    def test_sections_hosts_sorted_and_comments_ignored(self):
        p = C.parse_curated(self.BASIC)
        self.assertEqual(p["ads"], {"hosts": ["a.ads.com", "b.ads.com"], "exclusions": []})
        self.assertEqual(p["trackers"], {"hosts": ["quantcast.com", "t.example"], "exclusions": ["cmp.quantcast.com"]})
        self.assertEqual(p["never"], ["cdn.example", "cmp.quantcast.com"])

    def test_rule_shape(self):
        rules, info = curated(self.BASIC)
        self.assertEqual(sorted(rules), ["ads_curated", "privacy_curated"])
        self.assertEqual(rules["ads_curated"], [{
            "id": 1, "priority": 1, "action": {"type": "block"},
            "condition": {"requestDomains": ["a.ads.com", "b.ads.com"], "domainType": "thirdParty"}}])
        self.assertEqual(rules["privacy_curated"][0]["condition"], {
            "requestDomains": ["quantcast.com", "t.example"], "domainType": "thirdParty",
            "excludedRequestDomains": ["cmp.quantcast.com"]})
        for rs in rules.values():
            self.assertEqual(dnr_schema.ruleset_errors(rs), [])
            self.assertEqual(dnr_schema.curated_ruleset_errors(rs), [])
            self.assertLess(rs[0]["id"], F.ALLOW_ID_BASE)
            self.assertNotIn("resourceTypes", rs[0]["condition"])
        self.assertEqual(info, {"source": "rules/curated_hosts.txt", "never": 2,
                                "ads": {"hosts": 2, "exclusions": 0},
                                "trackers": {"hosts": 2, "exclusions": 1}})

    def test_never_covered_by_exclusion_is_ok_but_uncovered_overlap_fails(self):
        curated(self.BASIC)  # cmp.quantcast.com is excluded -> fine
        for text in ("[ads]\nx.com\n[trackers]\nt.com\n[never]\nx.com\n",
                     "[ads]\nx.com\n[trackers]\nt.com\n[never]\nsub.x.com\n",
                     "[ads]\nx.com\n-other.x.com\n[trackers]\nt.com\n[never]\nsub.x.com\n",
                     # an exclusion in the other section does not help
                     "[ads]\nx.com\n[trackers]\nt.com\n-sub.t.com\n[never]\nsub.x.com\n"):
            with self.assertRaisesRegex(C.CuratedError, "never"):
                curated(text)
        # a never host above a blocked host is not blocked by it
        curated("[ads]\na.x.com\n[trackers]\nt.com\n[never]\nx.com\n")

    def test_invalid_hosts(self):
        for bad in ("Ads.com", "ads..com", "-x.com.", "ads.com/path", "ads com", "réclame.fr",
                    "localhost", "*.ads.com", "ads.com.", "a_b.com", "-bad-.com", "xn--zz.com",
                    "x" * 64 + ".com"):
            with self.assertRaises(C.CuratedError, msg=bad):
                C.parse_curated("[ads]\n%s\n[trackers]\nt.com\n" % bad)
        C.parse_curated("[ads]\nxn--bcher-kva.example\n[trackers]\nt.com\n")  # punycode is fine

    def test_duplicates_rejected(self):
        for text in ("[ads]\na.com\na.com\n[trackers]\nt.com\n",
                     "[ads]\na.com\n[trackers]\na.com\n",
                     "[ads]\na.com\n-x.a.com\n-x.a.com\n[trackers]\nt.com\n",
                     "[ads]\na.com\n[trackers]\nt.com\n[never]\nn.com\nn.com\n",
                     "[ads]\na.com\n[ads]\nb.com\n[trackers]\nt.com\n"):
            with self.assertRaisesRegex(C.CuratedError, "duplicate", msg=text):
                C.parse_curated(text)

    def test_structure_errors(self):
        cases = {
            "[ads]\na.com\n[trackers]\nt.com\n[cosmetic]\nc.com\n": "unknown section",
            "a.com\n[ads]\nb.com\n[trackers]\nt.com\n": "before any section",
            "[ads]\n[trackers]\nt.com\n": "no hosts",
            "[ads]\na.com\n": "trackers",
            "[ads]\na.com\n[trackers]\nt.com\n[never]\n-n.com\n": "exclusion",
            "[ads]\na.com\n-b.com\n[trackers]\nt.com\n": "excludes nothing",
            "[ads]\na.com\n-a.com\n[trackers]\nt.com\n": "excludes nothing",
        }
        for text, msg in cases.items():
            with self.assertRaisesRegex(C.CuratedError, msg, msg=text):
                curated(text)

    def test_error_names_the_line(self):
        with self.assertRaisesRegex(C.CuratedError, "line 3"):
            C.parse_curated("[ads]\na.com\nBAD.com\n[trackers]\nt.com\n")

    def test_the_real_list_builds(self):
        with open(os.path.join(ROOT, "rules", "curated_hosts.txt"), encoding="utf-8") as fh:
            rules, info = curated(fh.read())
        self.assertGreater(info["ads"]["hosts"], 10)
        self.assertGreater(info["trackers"]["hosts"], 10)
        self.assertGreater(info["never"], 0)


class CuratedBuild(unittest.TestCase):
    def test_ruleset_order(self):
        ids = ["cookie_strip", "privacy_curated", "cookies_1", "ads_curated", "privacy_2", "ads_10", "ads_2", "privacy_1"]
        got = [r["id"] for r in build_rules.order_rulesets([{"id": i} for i in ids])]
        self.assertEqual(got, ["ads_2", "ads_10", "ads_curated", "privacy_1", "privacy_2", "privacy_curated",
                               "cookies_1", "cookie_strip"])

    def test_hand_written_youtube_ruleset_goes_last_and_is_never_cleaned_up(self):
        import fnmatch
        got = [r["id"] for r in build_rules.order_rulesets([{"id": i} for i in ("youtube", "cookie_strip", "ads_1")])]
        self.assertEqual(got, ["ads_1", "cookie_strip", "youtube"])
        self.assertEqual(dnr_schema.general_order_key("youtube"), (4, 0))
        self.assertTrue(dnr_schema.GENERATED_RULESET_RE.match("youtube"))
        for pattern in build_rules.GENERATED_GLOBS:
            self.assertFalse(fnmatch.fnmatch("youtube.json", os.path.basename(pattern)), pattern)

    def test_cleanup_globs_spare_curated_files(self):
        import fnmatch
        for pattern in build_rules.GENERATED_GLOBS:
            name = os.path.basename(pattern)
            self.assertFalse(fnmatch.fnmatch("ads_curated.json", name), pattern)
            self.assertFalse(fnmatch.fnmatch("privacy_curated.json", name), pattern)
        self.assertTrue(any(fnmatch.fnmatch("ads_12.json", os.path.basename(p)) for p in build_rules.GENERATED_GLOBS))

    def test_curated_only_touches_only_curated_outputs(self):
        root = tempfile.mkdtemp(prefix="adshield-test-curated-")
        os.makedirs(os.path.join(root, "rules"))
        rr = [{"id": "client_ads", "enabled": True, "path": "rules/client_ads.json"},
              {"id": "trackers", "enabled": False, "path": "rules/trackers.json"}] + [
             {"id": i, "enabled": True, "path": "rules/%s.json" % i} for i in ("ads_1", "privacy_1", "cookies_1", "cookie_strip")]
        with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({"name": "x", "declarative_net_request": {"rule_resources": rr}}, fh)
        old_info = {"lists": {"easylist": {"version": "7"}}, "rulesets": {"ads_1": {"rules": 5}, "privacy_1": {"rules": 3}},
                    "totalStaticRules": 8}
        with open(os.path.join(root, "rules", "build-info.json"), "w", encoding="utf-8") as fh:
            json.dump(old_info, fh)
        with open(os.path.join(root, "rules", "ads_1.json"), "w", encoding="utf-8") as fh:
            fh.write("SENTINEL")
        with open(os.path.join(root, "rules", "curated_hosts.txt"), "w", encoding="utf-8") as fh:
            fh.write(CuratedHosts.BASIC)
        with open(os.path.join(root, "rules", "removeparams.txt"), "w", encoding="utf-8") as fh:
            fh.write("utm_source\nfbclid  # comment\n")
        build_rules.curated_only(root)
        with open(os.path.join(root, "manifest.json"), encoding="utf-8") as fh:
            m = json.load(fh)
        self.assertEqual([r["id"] for r in m["declarative_net_request"]["rule_resources"]],
                         ["client_ads", "trackers", "ads_1", "ads_curated", "privacy_1", "privacy_curated", "cookies_1", "cookie_strip",
                          "youtube", "removeparam"], "youtube is always kept; removeparam rebuilt and last")
        for r in m["declarative_net_request"]["rule_resources"][2:]:
            self.assertIs(r["enabled"], True)
            self.assertEqual(r["path"], "rules/%s.json" % r["id"])
        with open(os.path.join(root, "rules", "ads_1.json"), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "SENTINEL")
        with open(os.path.join(root, "rules", "build-info.json"), encoding="utf-8") as fh:
            info = json.load(fh)
        self.assertEqual(info["lists"], old_info["lists"])
        self.assertEqual(info["curated"]["trackers"], {"hosts": 2, "exclusions": 1})
        self.assertEqual(info["rulesets"]["ads_curated"]["rules"], 1)
        self.assertEqual(info["totalStaticRules"], 14)
        self.assertEqual(info["removeparam"], {"params": 2})
        with open(os.path.join(root, "rules", "removeparam.json"), encoding="utf-8") as fh:
            self.assertEqual(len(json.load(fh)), 4)
        for rid in ("ads_curated", "privacy_curated"):
            with open(os.path.join(root, "rules", rid + ".json"), encoding="utf-8") as fh:
                self.assertEqual(dnr_schema.curated_ruleset_errors(json.load(fh)), [])
        # Running it again changes nothing.
        before = open(os.path.join(root, "manifest.json"), encoding="utf-8").read()
        build_rules.curated_only(root)
        self.assertEqual(open(os.path.join(root, "manifest.json"), encoding="utf-8").read(), before)

    def test_curated_only_fails_on_bad_list_without_writing(self):
        root = tempfile.mkdtemp(prefix="adshield-test-curated-bad-")
        os.makedirs(os.path.join(root, "rules"))
        with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({"declarative_net_request": {"rule_resources": []}}, fh)
        with open(os.path.join(root, "rules", "curated_hosts.txt"), "w", encoding="utf-8") as fh:
            fh.write("[ads]\nx.com\n[trackers]\nt.com\n[never]\nx.com\n")
        with self.assertRaises(C.CuratedError):
            build_rules.curated_only(root)
        self.assertFalse(os.path.exists(os.path.join(root, "rules", "ads_curated.json")))


class Removeparam(unittest.TestCase):
    def test_parse_comments_and_errors(self):
        self.assertEqual(R.parse("# c\nutm_source\n\nfbclid   # Meta\n_hsenc\n"), ["utm_source", "fbclid", "_hsenc"])
        for bad, why in (("utm_source\nutm_source", "duplicate"), ("utm-source", "not a parameter"), ("ref", "generic"),
                         ("SI", "generic"), ("mkt_tok", "generic"), ("a b", "not a parameter"), ("# only comments\n", "empty")):
            with self.assertRaises(R.RemoveparamError) as cm:
                R.parse(bad)
            self.assertIn(why, str(cm.exception), bad)

    def test_rule_shape(self):
        rules = R.build_rules(["utm_source", "fbclid"])
        self.assertEqual(dnr_schema.removeparam_ruleset_errors(rules), [])
        self.assertEqual([r["condition"]["urlFilter"] for r in rules], ["?utm_source=", "&utm_source=", "?fbclid=", "&fbclid="])
        self.assertEqual([r["id"] for r in rules], [1, 2, 3, 4])
        for r in rules:
            self.assertEqual(r["action"]["redirect"]["transform"]["queryTransform"]["removeParams"], ["utm_source", "fbclid"])
            self.assertEqual(r["condition"]["resourceTypes"], ["main_frame", "sub_frame"])
            self.assertTrue(r["condition"]["isUrlFilterCaseSensitive"])
            self.assertIn("googleadservices.com", r["condition"]["excludedRequestDomains"])
            self.assertTrue(F.PRIORITY_ALLOW_IMPORTANT < r["priority"] < 100, "above list rules, below the allowlist")

    def test_shape_check_rejects_deviations(self):
        good = R.build_rules(["utm_source"])[0]
        changes = [
            lambda r: r.update(priority=100),
            lambda r: r.update(priority=2),
            lambda r: r["action"]["redirect"]["transform"]["queryTransform"].update(addOrReplaceParams=[{"key": "a", "value": "b"}]),
            lambda r: r["action"].update(redirect={"url": "https://x.com/"}),
            lambda r: r["condition"].update(urlFilter="utm_source="),
            lambda r: r["condition"].update(urlFilter="?other="),
            lambda r: r["condition"].update(resourceTypes=["script"]),
            lambda r: r["condition"].pop("isUrlFilterCaseSensitive"),
            lambda r: r["condition"].update(requestDomains=["a.com"]),
            lambda r: r["action"]["redirect"]["transform"]["queryTransform"].update(removeParams=["utm_source", "utm_source"]),
        ]
        for i, change in enumerate(changes):
            r = json.loads(json.dumps(good))
            change(r)
            self.assertTrue(dnr_schema.removeparam_ruleset_errors([r]), i)
        other = R.build_rules(["utm_source", "x"])[1]
        other["id"] = 2
        self.assertTrue(dnr_schema.removeparam_ruleset_errors([good, other]), "rules must agree on the names")
        self.assertTrue(dnr_schema.removeparam_ruleset_errors([]))

    def test_committed_ruleset_matches_the_list(self):
        names = R.read(ROOT)
        with open(os.path.join(ROOT, R.OUTPUT), encoding="utf-8") as fh:
            committed = json.load(fh)
        self.assertEqual(committed, R.build_rules(names), "run python3 -I tools/build_rules.py --curated-only")
        for n in ("utm_source", "utm_viz_id", "fbclid", "gclid", "msclkid", "srsltid", "_hsenc", "igshid"):
            self.assertIn(n, names)
        for n in ("si", "ref", "mkt_tok", "source", "id"):
            self.assertNotIn(n, names)


class Schema(unittest.TestCase):
    def test_schema_rejects_bad_rules(self):
        bad = [
            {"id": 0, "action": {"type": "block"}, "condition": {"urlFilter": "x"}},
            {"id": 1, "action": {"type": "nope"}, "condition": {}},
            {"id": 1, "action": {"type": "block"}, "condition": {"urlFilter": "||*x"}},
            {"id": 1, "action": {"type": "block"}, "condition": {"urlFilter": "ré"}},
            {"id": 1, "action": {"type": "block"}, "condition": {"requestDomains": []}},
            {"id": 1, "action": {"type": "block"}, "condition": {"requestDomains": ["A.com"]}},
            {"id": 1, "action": {"type": "block"}, "condition": {"resourceTypes": ["popup"]}},
            {"id": 1, "action": {"type": "block"}, "condition": {"regexFilter": "(?=x)"}},
            {"id": 1, "action": {"type": "allowAllRequests"}, "condition": {"resourceTypes": ["script"]}},
            {"id": 1, "action": {"type": "modifyHeaders"}, "condition": {}},
            {"id": 1, "action": {"type": "modifyHeaders", "requestHeaders": [{"header": "c", "operation": "remove", "value": "x"}]}, "condition": {}},
            {"id": 1, "action": {"type": "block"}, "condition": {"urlFilter": "x", "regexFilter": "x"}},
            {"id": 1, "action": {"type": "block"}, "condition": {"bogus": 1}},
        ]
        for r in bad:
            self.assertTrue(dnr_schema.rule_errors(r), json.dumps(r))
        self.assertTrue(dnr_schema.ruleset_errors([bad[2], bad[2]]))
        ok = {"id": 3, "priority": 2, "action": {"type": "allow"}, "condition": {"urlFilter": "|https://x.com/a^", "domainType": "thirdParty"}}
        self.assertEqual(dnr_schema.rule_errors(ok), [])

    def test_curated_shape_check_rejects_deviations(self):
        good = {"id": 1, "priority": 1, "action": {"type": "block"},
                "condition": {"requestDomains": ["a.com", "b.com"], "domainType": "thirdParty", "excludedRequestDomains": ["x.a.com"]}}
        self.assertEqual(dnr_schema.curated_ruleset_errors([good]), [])
        changes = [
            lambda r: r["condition"].update(resourceTypes=["script"]),
            lambda r: r["condition"].update(resourceTypes=["main_frame"]),
            lambda r: r["condition"].update(domainType="firstParty"),
            lambda r: r["condition"].pop("domainType"),
            lambda r: r.update(priority=2),
            lambda r: r.update(id=F.ALLOW_ID_BASE + 1),
            lambda r: r.update(action={"type": "allow"}),
            lambda r: r["condition"].update(requestDomains=["b.com", "a.com"]),
            lambda r: r["condition"].update(requestDomains=["com", "a.com"]),
            lambda r: r["condition"].update(excludedRequestDomains=["y.other.com"]),
            lambda r: r["condition"].update(urlFilter="/ads"),
        ]
        for i, change in enumerate(changes):
            r = json.loads(json.dumps(good))
            change(r)
            self.assertTrue(dnr_schema.curated_ruleset_errors([r]), i)
        self.assertTrue(dnr_schema.curated_ruleset_errors([good, dict(good, id=2)]))
        self.assertTrue(dnr_schema.curated_ruleset_errors([]))

    def test_general_ruleset_ids_and_order(self):
        for rid in ("ads_1", "privacy_12", "cookies_3", "cookie_strip", "ads_curated", "privacy_curated", "removeparam"):
            self.assertTrue(dnr_schema.GENERATED_RULESET_RE.match(rid), rid)
        for rid in ("cookies_curated", "ads_", "ads_x", "trackers"):
            self.assertFalse(dnr_schema.GENERATED_RULESET_RE.match(rid), rid)
        ids = ["ads_1", "ads_curated", "privacy_1", "privacy_curated", "cookies_1", "cookie_strip"]
        self.assertEqual(sorted(reversed(ids), key=dnr_schema.general_order_key), ids)


class GeneratedData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
            cls.manifest = json.load(fh)
        with open(os.path.join(ROOT, "rules", "build-info.json"), encoding="utf-8") as fh:
            cls.info = json.load(fh)
        cls.rulesets = {}
        for r in cls.manifest["declarative_net_request"]["rule_resources"]:
            with open(os.path.join(ROOT, r["path"]), encoding="utf-8") as fh:
                cls.rulesets[r["id"]] = json.load(fh)

    def test_every_generated_rule_passes_the_schema(self):
        n = 0
        for rid, rules in self.rulesets.items():
            if rid in ("client_ads", "trackers"):
                continue
            self.assertEqual(dnr_schema.ruleset_errors(rules, rid), [], rid)
            n += len(rules)
        self.assertGreater(n, 1000)

    def test_limits(self):
        enabled = [r["id"] for r in self.manifest["declarative_net_request"]["rule_resources"] if r["enabled"]]
        total = sum(len(self.rulesets[i]) for i in enabled)
        self.assertLessEqual(total, dnr_schema.GUARANTEED_MINIMUM_STATIC_RULES)
        self.assertLessEqual(sum(dnr_schema.regex_count(r) for r in self.rulesets.values()), dnr_schema.MAX_NUMBER_OF_REGEX_RULES)
        for rid, rules in self.rulesets.items():
            self.assertLessEqual(len(rules), F.MAX_RULES_PER_RULESET, rid)

    def test_build_info_matches_files(self):
        for rid, meta in self.info["rulesets"].items():
            self.assertEqual(meta["rules"], len(self.rulesets[rid]), rid)
        for key, meta in self.info["lists"].items():
            self.assertIn("skipped", meta)
            self.assertEqual(meta["skippedTotal"], sum(meta["skipped"].values()), key)
            self.assertTrue(meta["version"], key)

    def test_allow_rules_use_the_allow_id_range(self):
        for rid, rules in self.rulesets.items():
            for r in rules:
                is_allow = r["action"]["type"] in ("allow", "allowAllRequests")
                if rid not in ("client_ads", "trackers"):
                    self.assertEqual(is_allow, r["id"] >= F.ALLOW_ID_BASE, (rid, r["id"]))

    def test_cookie_strip_ruleset(self):
        rules = self.rulesets["cookie_strip"]
        self.assertTrue(rules)
        doms = sum((r["condition"]["requestDomains"] for r in rules), [])
        self.assertLessEqual(len(doms), build_rules.COOKIE_STRIP_CAP)
        for r in rules:
            self.assertEqual(r["action"]["type"], "modifyHeaders")
            self.assertEqual(r["condition"]["domainType"], "thirdParty")

    def test_twitch_playback_hosts_never_blocked(self):
        # The general lists must not break Twitch playback: no block rule on these hosts.
        hosts = ("usher.ttvnw.net", "gql.twitch.tv", "www.twitch.tv", "player.twitch.tv",
                 "video-weaver.fra02.hls.ttvnw.net", "video-edge-1.fra02.abs.hls.ttvnw.net",
                 "playlist.live-video.net", "static.twitchcdn.net")
        words = ("usher", "gql.twitch", "ttvnw", "video-weaver", "playlist.live-video")
        for rid, rules in self.rulesets.items():
            if rid in ("client_ads", "trackers"):
                continue
            for r in rules:
                if r["action"]["type"] != "block":
                    continue
                c = r["condition"]
                for d in c.get("requestDomains", []):
                    for h in hosts:
                        self.assertFalse(h == d or h.endswith("." + d), (rid, r["id"], d))
                for w in words:
                    self.assertNotIn(w, c.get("urlFilter") or c.get("regexFilter") or "", (rid, r["id"]))

    def test_curated_rulesets(self):
        ids = [r["id"] for r in self.manifest["declarative_net_request"]["rule_resources"]]
        for rid in dnr_schema.CURATED_RULESETS:
            self.assertIn(rid, ids)
            self.assertEqual(dnr_schema.curated_ruleset_errors(self.rulesets[rid]), [], rid)
            self.assertEqual(self.info["rulesets"][rid]["rules"], 1)
        self.assertEqual(self.info["curated"]["ads"]["hosts"], len(self.rulesets["ads_curated"][0]["condition"]["requestDomains"]))
        self.assertEqual(self.info["curated"]["trackers"]["hosts"],
                         len(self.rulesets["privacy_curated"][0]["condition"]["requestDomains"]))

    def test_cosmetic_files(self):
        cdir = os.path.join(ROOT, "rules", "cosmetic")
        self.assertFalse(os.path.exists(os.path.join(cdir, "site.json")), "replaced by site/ shards")
        site = CO.read_site(cdir)
        with open(os.path.join(cdir, "generic.json"), encoding="utf-8") as fh:
            generic = json.load(fh)
        self.assertEqual(site["v"], 1)
        for k in ("ads", "cookies", "exceptions", "genericExceptionHosts", "generichide", "elemhide", "genericFullHosts"):
            self.assertIn(k, site)
        self.assertGreater(len(site["ads"]), 5000)
        self.assertGreater(len(generic["ads"]), 1000)
        self.assertGreater(len(generic["cookies"]), 1000)
        for h in site["genericExceptionHosts"] + site["generichide"] + site["elemhide"]:
            self.assertIn(".", h, "a single-label host would exclude a whole TLD from generic hiding")
        for name in ("ads_generic.css", "ads_generic_top.css", "cookies_generic.css", "ads_excepted.css", "cookies_excepted.css"):
            with open(os.path.join(cdir, name), encoding="utf-8") as fh:
                css = fh.read()
            self.assertEqual(css.count("{display:none!important}"), css.count("\n") - 1)
            for line in css.split("\n")[1:]:
                if line:
                    self.assertRegex(line, r"^[^{}]+\{display:none!important\}$")


class EndToEnd(unittest.TestCase):
    def test_convert_small_lists(self):
        lists = tempfile.mkdtemp(prefix="adshield-test-lists-")
        out = tempfile.mkdtemp(prefix="adshield-test-out-")
        os.makedirs(os.path.join(out, "rules"))
        texts = {
            "easylist.txt": "[Adblock Plus 2.0]\n! Version: 1\n||ads.example^\n/banner/*$image\n||x.com^$popup\n##.ad\na.com##.side-ad\na.com#@#.ad\n@@||good.example^$generichide\n",
            "easyprivacy.txt": "! Version: 2\n||trk.example^$third-party\n||pixel.example^\n@@||trk.example/ok.js$script\n",
            "easylist-cookie.txt": "! Version: 3\n||cmp.example^$script\n##.cookie-bar\nb.com##.consent\n",
        }
        for name, text in texts.items():
            with open(os.path.join(lists, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        rulesets, info = build_rules.convert(lists, out)
        self.assertEqual([r["id"] for r in rulesets], ["ads_1", "privacy_1", "cookies_1", "cookie_strip"])
        self.assertEqual(info["lists"]["easylist"]["skipped"].get("popup"), 1)
        self.assertEqual(info["cookieStrip"]["domains"], 1)
        for r in rulesets:
            with open(os.path.join(out, r["path"]), encoding="utf-8") as fh:
                self.assertEqual(dnr_schema.ruleset_errors(json.load(fh)), [])
        site = CO.read_site(os.path.join(out, "rules", "cosmetic"))
        self.assertEqual(site["ads"], {"a.com": [".side-ad"]})
        self.assertEqual(site["cookies"], {"b.com": [".consent"]})
        self.assertEqual(site["genericExceptionHosts"], ["a.com"])
        self.assertEqual(site["generichide"], ["good.example"])
        self.assertEqual(site["genericFullHosts"], [])
        cdir = os.path.join(out, "rules", "cosmetic")
        with open(os.path.join(cdir, "ads_excepted.css"), encoding="utf-8") as fh:
            self.assertIn(".ad{display:none!important}", fh.read(), "a.com#@#.ad: in the excepted file")
        with open(os.path.join(cdir, "ads_generic.css"), encoding="utf-8") as fh:
            self.assertNotIn(".ad{", fh.read())
        with open(os.path.join(cdir, "cookies_generic.css"), encoding="utf-8") as fh:
            self.assertIn(".cookie-bar{display:none!important}", fh.read())
        self.assertTrue(os.path.isfile(os.path.join(cdir, "ads_generic_top.css")))
        self.assertEqual(len([f for f in os.listdir(os.path.join(cdir, "site")) if f.endswith(".json")]), CO.SITE_SHARDS + 1)
        self.assertEqual(info["cosmetic"]["files"]["adsCore"], 0)
        self.assertEqual(info["cosmetic"]["files"]["adsExcepted"], 1)


class GenericTiers(unittest.TestCase):
    """tools/cosmetic.py: generic ad selectors split into a core (every frame) and the rest
    (top frame); cookie-banner generic CSS top frame only."""

    def test_core_rule(self):
        for sel in (".ad-banner", "#ad-top", 'div[id^="ad-"]', ".sponsored > .label", '[id^="div-gpt-ad"]',
                    "ins.adsbygoogle[data-ad-client]", "AMP-AD", "#AdSkyscraper", ".ad-300x250", "#adsense"):
            self.assertTrue(CO.is_core_candidate(sel), sel)
        for sel in (".widget_wpstealthads_widget", "#rightrail_pos1_ddb_0", 'a[href^="https://glersakr.com/"]',
                    ".generic-excepted", ".banner", "#top-sidebar", ".adv-top-right-side-box-wrapper", ".anyClipWrapper"):
            self.assertFalse(CO.is_core_candidate(sel), sel)

    def test_split_keeps_every_selector_once_and_respects_the_budget(self):
        sels = [".ad", ".ads-box", ".foo", "#ad-top-banner-wrapper", ".adv", ".bar-ad"]
        core, top = CO.split_ad_tiers(sels, budget=12)
        self.assertEqual(core, [".ad", ".adv"], "fewest words, then shortest, until the budget is used")
        self.assertEqual(top, [".ads-box", ".foo", "#ad-top-banner-wrapper", ".bar-ad"])
        core, top = CO.split_ad_tiers(sels)
        self.assertEqual(sorted(core + top), sorted(sels))
        self.assertEqual(top, [".foo"])

    def test_golden_generic_coverage(self):
        """Fixture lists: the top frame keeps every generic selector; sub-frames keep the ad-slot ones."""
        g = make_golden.golden()["generic"]
        core, top = CO.split_ad_tiers(g["ads"])
        self.assertEqual(sorted(core + top), sorted(g["ads"]))
        self.assertEqual(core, [".ad-banner", "#ad-top", 'div[id^="ad-"]', ".sponsored > .label"])
        self.assertEqual(top, [".generic-excepted", ".generic-excepted2", ".generic-with-neg"])

    def test_committed_tiers(self):
        cdir = os.path.join(ROOT, "rules", "cosmetic")
        generic, site = CO.read_committed()
        excepted = CO.excepted_selectors(generic, site)
        skip = set(excepted["ads"]) | set(excepted["cookies"])
        core, top = CO.split_ad_tiers([s for s in generic["ads"] if s not in skip])
        self.assertLessEqual(sum(len(s) + 1 for s in core), CO.CORE_MAX_BYTES)
        self.assertGreater(len(core), 2000)
        every_frame = set(core) | set(excepted["ads"])
        for sel in ('[id^="div-gpt-ad"]', '[id^="google_ads_iframe_"]', "ins.adsbygoogle[data-ad-client]", "AMP-AD"):
            self.assertIn(sel, every_frame)
        want = {"ads_generic.css": (core, "EasyList (generic core, every frame)"),
                "ads_generic_top.css": (top, "EasyList (other generic, top frame)"),
                "cookies_generic.css": ([s for s in generic["cookies"] if s not in skip], "the EasyList Cookie List (top frame)"),
                "ads_excepted.css": (excepted["ads"], "EasyList (generic, excepted on some sites)"),
                "cookies_excepted.css": (excepted["cookies"], "the EasyList Cookie List (generic, excepted on some sites)")}
        for name, (sels, source) in want.items():
            with open(os.path.join(cdir, name), encoding="utf-8") as fh:
                self.assertEqual(fh.read(), CO.css_file(sels, source), "run python3 -I tools/cosmetic.py: " + name)
        size = 0
        for name in ("ads_generic.css", "ads_excepted.css"):
            with open(os.path.join(cdir, name), encoding="utf-8") as fh:
                size += len(fh.read())
        self.assertLess(size, 56 * 1024, "the CSS every frame parses stays small")
        with open(os.path.join(cdir, "generic_excepted.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), excepted)
        self.assertGreater(len(excepted["ads"]) + len(excepted["cookies"]), 100)
        self.assertEqual(site["genericFullHosts"], [], "packaged: every excepted selector is in the excepted files")
        self.assertEqual(CO.full_generic_hosts(site, generic, excepted), [])


class SiteShards(unittest.TestCase):
    """tools/cosmetic.py site/ shards (same functions as src/shared/blocking.js; parity is checked
    in tests/blocking.test.js against these files)."""

    def test_shard_key_keeps_parents_together(self):
        self.assertEqual(CO.shard_key("a.b.example.com"), "example.com")
        self.assertEqual(CO.shard_key("www.bbc.co.uk"), "bbc.co.uk")
        self.assertEqual(CO.shard_key("example.com"), "example.com")
        self.assertTrue(CO.is_global_host("co.uk") and CO.is_global_host("uk") and CO.is_global_host("gov.uk"))
        self.assertFalse(CO.is_global_host("example.com"))
        for host in ("www.bbc.co.uk", "a.b.c.example.org", "x.y.gov.pl", "10.0.0.1", "deep.sub.site.com.au"):
            labels = host.split(".")
            for i in range(len(labels)):
                parent = ".".join(labels[i:])
                if not CO.is_global_host(parent):
                    self.assertEqual(CO.shard_of(parent), CO.shard_of(host), (host, parent))
        self.assertEqual(CO.fnv1a(""), 0x811C9DC5)
        self.assertEqual(CO.fnv1a("a"), 0xE40C292C)

    def test_split_merge_round_trip(self):
        site = dict(make_golden.golden()["site"])
        site["genericFullHosts"] = []
        index, shards = CO.split_site(site)
        self.assertEqual(len(shards), CO.SITE_SHARDS)
        self.assertEqual(index["genericExceptionHosts"], site["genericExceptionHosts"])
        self.assertEqual(CO.merge_site(index, shards), site)

    def test_committed_shards(self):
        sdir = os.path.join(ROOT, "rules", "cosmetic", "site")
        names = sorted(f for f in os.listdir(sdir) if f.endswith(".json"))
        self.assertEqual(names, sorted(["index.json"] + ["%02x.json" % i for i in range(CO.SITE_SHARDS)]))
        with open(os.path.join(ROOT, "src", "shared", "blocking.js"), encoding="utf-8") as fh:
            self.assertEqual(int(re.search(r"var SITE_SHARDS = (\d+);", fh.read()).group(1)), CO.SITE_SHARDS)
        biggest = 0
        for i in range(CO.SITE_SHARDS):
            path = os.path.join(sdir, CO.shard_name(i) + ".json")
            biggest = max(biggest, os.path.getsize(path))
            with open(path, encoding="utf-8") as fh:
                sh = json.load(fh)
            for k in CO.SITE_MAPS:
                for h in sh[k]:
                    self.assertTrue(CO.is_global_host(h) or CO.shard_of(h) == i, (i, h))
        self.assertLess(biggest, 32 * 1024, "a page reads one small shard")
        generic, site = CO.read_committed()
        index, shards = CO.split_site(site)
        with open(os.path.join(sdir, "index.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), index)


class Golden(unittest.TestCase):
    """tests/fixtures/lists/golden.json is what the Python converter makes of the fixture lists;
    tests/filterlist.test.js checks the JavaScript port against the same file."""

    def test_golden_equals_current_python_output(self):
        with open(make_golden.GOLDEN, encoding="utf-8") as fh:
            committed = json.load(fh)
        current = json.loads(make_golden.dumps(make_golden.golden()))
        self.assertEqual(committed, current, "run python3 -I tools/make_golden.py (and update src/shared/filterlist.js)")

    def test_golden_covers_the_filter_shapes(self):
        g = make_golden.golden()
        ads = g["lists"]["easylist"]
        for reason in ("popup", "document-block", "option:csp", "option:unknown", "regex", "wildcard-domain",
                       "bad-domain", "non-ascii", "too-broad", "whitespace", "pipe-in-pattern",
                       "procedural-or-scriptlet", "bad-selector", "cosmetic-exception-pattern"):
            self.assertIn(reason, ads["skipped"], reason)
        rules = ads["rules"]
        conds = [r["condition"] for r in rules]
        self.assertTrue(any("regexFilter" in c for c in conds))
        self.assertTrue(any("requestDomains" in c for c in conds))
        self.assertTrue(any(r["action"]["type"] == "allowAllRequests" for r in rules))
        self.assertTrue(any(r["priority"] == F.PRIORITY_IMPORTANT for r in rules))
        self.assertTrue(any(r["priority"] == F.PRIORITY_ALLOW_IMPORTANT for r in rules))
        self.assertTrue(any(d.startswith("xn--") for c in conds for d in c.get("initiatorDomains", [])))
        self.assertTrue(g["site"]["generichide"] and g["site"]["elemhide"] and g["site"]["genericExceptionHosts"])
        for key, lst in g["lists"].items():
            self.assertEqual(dnr_schema.ruleset_errors(lst["rules"], key), [], key)


class StripJs(unittest.TestCase):
    """tools/build.py strip_js: the userscript's comment / blank line remover."""

    def test_comment_lines_blank_lines_and_trailing_space_go(self):
        src = "// head\n/* one\n * two\n */\nvar a = 1;   \n\n   // indented\n  /** doc */\nf(a); // kept\n"
        self.assertEqual(build.strip_js(src), "var a = 1;\nf(a); // kept")

    def test_template_literal_lines_kept_verbatim(self):
        src = "var t = `x\n// not a comment  \n/* nor this */\n\n${ {a: 1}.a }`;\n// gone\nvar u = `${`\n//in`}`;\n"
        self.assertEqual(build.strip_js(src), "var t = `x\n// not a comment  \n/* nor this */\n\n${ {a: 1}.a }`;\nvar u = `${`\n//in`}`;")

    def test_string_continuation_kept(self):
        src = "var s = 'a\\\n// still the string';\n// gone\n"
        self.assertEqual(build.strip_js(src), "var s = 'a\\\n// still the string';")

    def test_regex_and_strings_with_comment_marks(self):
        src = "var r = /'\\/*\"[/*]/g, q = \"//\" + '/*';\n// gone\nx = a / b / c;\n/* gone */\n"
        self.assertEqual(build.strip_js(src), "var r = /'\\/*\"[/*]/g, q = \"//\" + '/*';\nx = a / b / c;")

    def test_block_followed_by_code_kept_and_mid_line_block_left_alone(self):
        src = "/* a\n*/ run();\nx(); /* open\n// closes here */ y();\n"
        self.assertEqual(build.strip_js(src), "/* a\n*/ run();\nx(); /* open\n// closes here */ y();")

    def test_misread_fails_loudly(self):
        for bad in ("var s = 'open\n", "var t = `open\n", "/* open\n"):
            with self.assertRaises(ValueError):
                build.strip_js(bad, "bad.js")

    def test_real_sources_lose_only_comment_and_blank_lines(self):
        import difflib
        files = build.BUNDLES[build.MAIN_WORLD] + build.SCRIPTLET_SOURCES
        for f in files + [None]:
            src = build.USERSCRIPT_RUNTIME if f is None else build.read(f)
            a = [l.rstrip() for l in src.split("\n")]
            b = build.strip_js(src, f or "runtime").split("\n")
            for tag, i1, i2, _j1, _j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
                if tag == "equal":
                    continue
                self.assertEqual(tag, "delete", f)
                for line in a[i1:i2]:
                    t = line.strip()
                    self.assertTrue(t == "" or t.startswith(("//", "/*", "*")), (f, line))

    def test_extension_bundles_keep_their_comments(self):
        self.assertIn("// ---- src/scriptlets/lib.js ----\n/*", build.render_scriptlets())
        self.assertIn("\n * ", build.render(build.BUNDLES[build.MAIN_WORLD]))


class Result(unittest.TextTestResult):
    pass


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    res = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(suite)
    if res.wasSuccessful():
        print("RESULT OK %d passed" % res.testsRun)
        sys.exit(0)
    print("RESULT FAIL")
    sys.exit(1)
