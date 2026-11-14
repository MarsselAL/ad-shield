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

    def test_cosmetic_files(self):
        cdir = os.path.join(ROOT, "rules", "cosmetic")
        with open(os.path.join(cdir, "site.json"), encoding="utf-8") as fh:
            site = json.load(fh)
        with open(os.path.join(cdir, "generic.json"), encoding="utf-8") as fh:
            generic = json.load(fh)
        self.assertEqual(site["v"], 1)
        for k in ("ads", "cookies", "exceptions", "genericExceptionHosts", "generichide", "elemhide"):
            self.assertIn(k, site)
        self.assertGreater(len(generic["ads"]), 1000)
        self.assertGreater(len(generic["cookies"]), 1000)
        for h in site["genericExceptionHosts"] + site["generichide"] + site["elemhide"]:
            self.assertIn(".", h, "a single-label host would exclude a whole TLD from generic hiding")
        for cat in ("ads", "cookies"):
            with open(os.path.join(cdir, "%s_generic.css" % cat), encoding="utf-8") as fh:
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
        with open(os.path.join(out, "rules", "cosmetic", "site.json"), encoding="utf-8") as fh:
            site = json.load(fh)
        self.assertEqual(site["ads"], {"a.com": [".side-ad"]})
        self.assertEqual(site["cookies"], {"b.com": [".consent"]})
        self.assertEqual(site["genericExceptionHosts"], ["a.com"])
        self.assertEqual(site["generichide"], ["good.example"])


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
