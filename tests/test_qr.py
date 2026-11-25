#!/usr/bin/env python3
"""Tests for tools/make_qr.py: the committed QR codes in src/assets/qr/ are exactly what the
addresses in src/shared/donate.js give (so a changed address cannot leave a stale code), with the
right payload per code, and the encoder produces well-formed symbols.

Run with:  python3 -I tests/test_qr.py      (offline; prints "RESULT OK <n> passed")
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import make_qr  # noqa: E402


class QR(unittest.TestCase):
    def test_values_are_read_from_donate_js(self):
        v = make_qr.donate_values()
        self.assertTrue(v["url"].startswith("https://"))
        self.assertTrue(re.match(r"^0x[0-9a-fA-F]{40}$", v["usdc"]), v["usdc"])
        self.assertTrue(re.match(r"^bc1[0-9a-z]{20,}$", v["btc"]), v["btc"])

    def test_committed_svgs_match_donate_js(self):
        files = make_qr.wanted()
        self.assertEqual(sorted(files), ["btc.svg", "revolut.svg", "usdc.svg"])
        for name, text in files.items():
            with open(os.path.join(make_qr.OUT, name), encoding="utf-8") as fh:
                self.assertEqual(fh.read(), text, name + " is stale: run python3 -I tools/make_qr.py")

    def test_payloads(self):
        v = make_qr.donate_values()
        seen = {}
        orig = make_qr.svg
        make_qr.svg = lambda text, label: seen.setdefault(label, text)
        try:
            make_qr.wanted()
        finally:
            make_qr.svg = orig
        payloads = sorted(seen.values())
        self.assertEqual(payloads, sorted([v["url"], v["usdc"], "bitcoin:" + v["btc"]]))
        self.assertFalse([p for p in payloads if p.startswith("ethereum:")], "USDC must be plain text")

    def test_a_changed_address_changes_the_code(self):
        v = make_qr.donate_values()
        other = dict(v, btc=v["btc"][:-1] + ("q" if v["btc"][-1] != "q" else "p"))
        self.assertNotEqual(make_qr.wanted(v)["btc.svg"], make_qr.wanted(other)["btc.svg"])

    def test_symbol_structure(self):
        m = make_qr.encode("https://example.com/")
        n = len(m)
        self.assertEqual((n - 17) % 4, 0)
        for x0, y0 in ((0, 0), (n - 7, 0), (0, n - 7)):   # finder patterns
            self.assertTrue(all(m[y0][x0 + i] and m[y0 + 6][x0 + i] for i in range(7)))
            self.assertTrue(all(m[y0 + 2 + i][x0 + 2 + j] for i in range(3) for j in range(3)))
        self.assertTrue(m[n - 8][8], "dark module")
        self.assertEqual([m[6][i] for i in range(8, n - 8)], [i % 2 == 0 for i in range(8, n - 8)])

    def test_svg_has_white_tile_and_quiet_zone(self):
        s = make_qr.svg("x", "label")
        self.assertIn('fill="#ffffff"', s)
        self.assertNotIn("M0 ", s)
        self.assertNotIn("M3 ", s.split('d="', 1)[1][:4])


if __name__ == "__main__":
    res = unittest.main(exit=False, verbosity=1).result
    ok = res.wasSuccessful()
    print("RESULT OK %d passed" % res.testsRun if ok else "RESULT FAIL")
    sys.exit(0 if ok else 1)
