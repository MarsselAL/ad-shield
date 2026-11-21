#!/usr/bin/env python3
"""Tests for tools/package.py: the zip to share has INSTALL.txt and manifest.json under ad-shield/
and no tests, tools, results or other docs; the store zip has manifest.json at its root and no
INSTALL.txt.

Run with:  python3 -I tests/test_package.py      (offline; prints "RESULT OK <n> passed")
"""
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import package  # noqa: E402


class Package(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="adshield-test-package-")
        cls.out = os.path.join(cls.tmp, "ad-shield-test.zip")
        package.build_zip(cls.out)
        with zipfile.ZipFile(cls.out) as z:
            cls.names = z.namelist()
            cls.install = z.read("ad-shield/INSTALL.txt").decode("utf-8")
        cls.store_out = os.path.join(cls.tmp, "ad-shield-test-store.zip")
        package.build_store_zip(cls.store_out)
        with zipfile.ZipFile(cls.store_out) as z:
            cls.store_names = z.namelist()
            cls.store_bytes = {n: z.read(n) for n in cls.store_names}
        with zipfile.ZipFile(cls.out) as z:
            cls.folder_bytes = {n: z.read(n) for n in cls.names}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_install_and_manifest_in_the_top_folder(self):
        for n in ("ad-shield/INSTALL.txt", "ad-shield/manifest.json", "ad-shield/LICENSE", "ad-shield/NOTICE.md",
                  "ad-shield/src/background/service-worker.js", "ad-shield/build/isolated-world.js",
                  "ad-shield/rules/removeparam.json", "ad-shield/src/content/picker.js", "ad-shield/icons/icon128.png"):
            self.assertIn(n, self.names)
        self.assertTrue(all(n.startswith("ad-shield/") for n in self.names))

    def test_no_development_files(self):
        bad = {"tests", "tools", "results", "dist", "docs", "__pycache__", ".git", ".claude", "_metadata"}
        for n in self.names:
            parts = n.split("/")
            self.assertFalse(set(parts[1:-1]) & bad, n)
            self.assertFalse(parts[-1].startswith("."), n)
            self.assertFalse(n.endswith(".pyc"), n)
        self.assertEqual([n for n in self.names if n.endswith(".txt") and n.count("/") == 1], ["ad-shield/INSTALL.txt"])

    def test_every_manifest_file_is_inside(self):
        import json
        with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
            m = json.load(fh)
        need = [m["background"]["service_worker"], m["action"]["default_popup"], m["options_ui"]["page"]]
        need += [r["path"] for r in m["declarative_net_request"]["rule_resources"]]
        need += [f for c in m["content_scripts"] for f in c["js"]]
        need += list(m["icons"].values())
        for f in need:
            self.assertIn("ad-shield/" + f, self.names)

    def test_install_text_is_the_repo_copy_and_covers_the_steps(self):
        with open(os.path.join(ROOT, "docs", "INSTALL.txt"), encoding="utf-8") as fh:
            repo = fh.read()
        info = package._build_module().donate_info()
        self.assertEqual(self.install, repo.rstrip("\n") + "\n\n" + package.support_text(info))
        self.assertTrue(self.install.endswith(
            "\n\nLike Ad Shield? Optional support:\n"
            "  Tip via Revolut: %s\n"
            "  USDC on Ethereum (ERC-20) only: %s\n"
            "  BTC on the Bitcoin network only: %s\n"
            "Sending other coins or using other networks will lose the funds.\n"
            % (info["url"], info["usdc_erc20"], info["btc"])), self.install[-400:])
        for words in ("chrome://extensions", "edge://extensions", "brave://extensions", "Developer mode", "Load unpacked",
                      "macOS", "Windows", "permanent", "reload", "pin", "Settings", "week", "Remove", "Disable"):
            self.assertIn(words, self.install, words)


    def test_install_addresses_equal_donate_js(self):
        """The addresses in INSTALL.txt are the ones the popup and settings page show."""
        import re
        with open(os.path.join(ROOT, "src", "shared", "donate.js"), encoding="utf-8") as fh:
            js = fh.read()
        for key, label in (("url", "Tip via Revolut"), ("usdcErc20", "USDC on Ethereum (ERC-20) only"),
                           ("btc", "BTC on the Bitcoin network only")):
            value = re.search(r"\b%s: '([^']*)'" % key, js).group(1)
            self.assertTrue(value, key)
            self.assertIn("\n  %s: %s\n" % (label, value), self.install)

    def test_store_zip_has_manifest_at_root(self):
        self.assertIn("manifest.json", self.store_names)
        for n in ("LICENSE", "NOTICE.md", "src/background/service-worker.js", "build/isolated-world.js",
                  "icons/icon128.png"):
            self.assertIn(n, self.store_names)
        self.assertFalse([n for n in self.store_names if n.startswith("ad-shield/")])

    def test_store_zip_has_no_install_metadata_or_dev_files(self):
        bad = {"tests", "tools", "results", "dist", "docs", "__pycache__", ".git", ".claude", "_metadata"}
        self.assertNotIn("INSTALL.txt", self.store_names)
        for n in self.store_names:
            parts = n.split("/")
            self.assertFalse(set(parts[:-1]) & bad, n)
            self.assertFalse(n.startswith("_metadata"), n)
            self.assertFalse(parts[-1].startswith("."), n)
            self.assertFalse(n.endswith(".pyc"), n)
            self.assertNotEqual(parts[-1], "INSTALL.txt", n)

    def test_store_zip_is_folder_zip_without_install_and_prefix(self):
        expect = {n[len("ad-shield/"):]: b for n, b in self.folder_bytes.items() if n != "ad-shield/INSTALL.txt"}
        self.assertEqual(sorted(self.store_names), sorted(expect))
        self.assertEqual(len(self.store_names), len(set(self.store_names)))
        for n, b in expect.items():
            self.assertEqual(self.store_bytes[n], b, n)


class InstallSupportLines(unittest.TestCase):
    """INSTALL.txt in the zip to share gets one line per value set in docs/donate.txt."""

    URL = "https://revolut.me/someone"
    USDC = "0x" + "aB" * 20
    BTC = "bc1q" + "q" * 38

    def install(self, donate):
        d = tempfile.mkdtemp(prefix="adshield-test-install-")
        try:
            os.makedirs(os.path.join(d, "docs"))
            for name, text in (("manifest.json", "{}"), ("LICENSE", "x"), ("NOTICE.md", "x"),
                               ("docs/INSTALL.txt", "Install steps\n\n")):
                with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                    fh.write(text)
            if donate is not None:
                with open(os.path.join(d, "docs", "donate.txt"), "w", encoding="utf-8") as fh:
                    fh.write(donate)
            out = os.path.join(d, "out.zip")
            package.build_zip(out, root=d)
            with zipfile.ZipFile(out) as z:
                return z.read("ad-shield/INSTALL.txt").decode("utf-8")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_no_donate_file_leaves_install_unchanged(self):
        self.assertEqual(self.install(None), "Install steps\n\n")
        self.assertEqual(self.install("# nothing\n"), "Install steps\n\n")

    def test_url_only(self):
        self.assertEqual(self.install(self.URL + "\n"),
                         "Install steps\n\nLike Ad Shield? Optional support:\n  Tip via Revolut: %s\n" % self.URL)

    def test_url_usdc_and_btc(self):
        self.assertEqual(
            self.install("%s\nusdc-erc20: %s\nbtc: %s\n" % (self.URL, self.USDC, self.BTC)),
            "Install steps\n\nLike Ad Shield? Optional support:\n"
            "  Tip via Revolut: %s\n"
            "  USDC on Ethereum (ERC-20) only: %s\n"
            "  BTC on the Bitcoin network only: %s\n"
            "Sending other coins or using other networks will lose the funds.\n" % (self.URL, self.USDC, self.BTC))

    def test_btc_only(self):
        self.assertEqual(
            self.install("btc: %s\n" % self.BTC),
            "Install steps\n\nLike Ad Shield? Optional support:\n"
            "  BTC on the Bitcoin network only: %s\n"
            "Sending other coins or using other networks will lose the funds.\n" % self.BTC)

    def test_bad_donate_file_fails_the_build(self):
        with self.assertRaises(ValueError):
            self.install("GB29 NWBK 6016 1331 9268 19\n")

    def test_store_zip_ignores_donate_and_install(self):
        d = tempfile.mkdtemp(prefix="adshield-test-store-")
        try:
            os.makedirs(os.path.join(d, "docs"))
            os.makedirs(os.path.join(d, "_metadata"))
            for name in ("manifest.json", "LICENSE", "NOTICE.md", "docs/INSTALL.txt", "_metadata/x.json"):
                with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                    fh.write("x")
            out = os.path.join(d, "store.zip")
            package.build_store_zip(out, root=d)
            with zipfile.ZipFile(out) as z:
                self.assertEqual(sorted(z.namelist()), ["LICENSE", "NOTICE.md", "manifest.json"])
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Donate(unittest.TestCase):
    """docs/donate.txt: optional; only one plain https link is ever accepted."""

    def check(self, text):
        d = tempfile.mkdtemp(prefix="adshield-test-donate-")
        try:
            os.makedirs(os.path.join(d, "docs"))
            if text is not None:
                with open(os.path.join(d, "docs", "donate.txt"), "w", encoding="utf-8") as fh:
                    fh.write(text)
            return package._build_module().donate_url(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_missing_or_empty_means_no_tip(self):
        self.assertEqual(self.check(None), "")
        self.assertEqual(self.check("# put your link here\n\n"), "")

    def test_https_link_accepted(self):
        self.assertEqual(self.check("# tip\nhttps://revolut.me/someone\n"), "https://revolut.me/someone")

    def test_anything_else_rejected(self):
        for bad in ("http://revolut.me/x", "GB29 NWBK 6016 1331 9268 19", "https://a.b/x y",
                    "https://a.b/<script>", "https://a.b/1\nhttps://c.d/2", "javascript:alert(1)"):
            with self.assertRaises(ValueError, msg=bad):
                self.check(bad)

    def info(self, text):
        d = tempfile.mkdtemp(prefix="adshield-test-donate-")
        try:
            os.makedirs(os.path.join(d, "docs"))
            with open(os.path.join(d, "docs", "donate.txt"), "w", encoding="utf-8") as fh:
                fh.write(text)
            return package._build_module().donate_info(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_usdc_line_accepted(self):
        addr = "0x" + "aB" * 20
        both = "https://revolut.me/someone\nusdc-erc20: %s\n" % addr
        self.assertEqual(self.info(both), {"url": "https://revolut.me/someone", "usdc_erc20": addr, "btc": ""})
        self.assertEqual(self.info("usdc-erc20: %s\n" % addr), {"url": "", "usdc_erc20": addr, "btc": ""})
        self.assertEqual(self.check(both), "https://revolut.me/someone")

    def test_btc_line_accepted(self):
        for btc in ("bc1q" + "q" * 38, "bc1q" + "p" * 58):
            self.assertEqual(self.info("btc: %s\n" % btc), {"url": "", "usdc_erc20": "", "btc": btc})

    def test_bad_btc_line_rejected(self):
        for bad in ("btc: bc1q123", "btc: BC1Q" + "Q" * 38, "btc: bc1q" + "b" * 38, "btc: 1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
                    "btc: bc1q" + "q" * 40, "btc: bc1q%s\nbtc: bc1q%s" % ("q" * 38, "p" * 38)):
            with self.assertRaises(ValueError, msg=bad):
                self.info(bad)

    def test_bad_usdc_line_rejected(self):
        for bad in ("usdc-erc20: 0x123", "usdc-erc20: 0x" + "g" * 40, "usdc-erc20: bc1qxyz",
                    "usdc-erc20: 0x%s\nusdc-erc20: 0x%s" % ("1" * 40, "2" * 40), "btc: 0x" + "1" * 40):
            with self.assertRaises(ValueError, msg=bad):
                self.info(bad)

    def test_extension_copy_matches_donate_txt(self):
        """src/shared/donate.js (popup and settings page) holds the same values as docs/donate.txt."""
        import re
        info = package._build_module().donate_info()
        with open(os.path.join(ROOT, "src", "shared", "donate.js"), encoding="utf-8") as fh:
            js = fh.read()
        url = re.search(r"\burl: '([^']*)'", js)
        usdc = re.search(r"\busdcErc20: '([^']*)'", js)
        btc = re.search(r"\bbtc: '([^']*)'", js)
        self.assertTrue(url and usdc and btc, "donate.js must define url, usdcErc20 and btc: '...'")
        self.assertEqual(url.group(1), info["url"])
        self.assertEqual(usdc.group(1), info["usdc_erc20"])
        self.assertEqual(btc.group(1), info["btc"])

    def test_owner_values(self):
        info = package._build_module().donate_info()
        self.assertEqual(info["url"], "https://revolut.me/marsel951u")
        self.assertEqual(info["usdc_erc20"], "0xD26B379f952D9a3008eB5a8C908d335F5715b18A")
        self.assertEqual(info["btc"], "bc1q37wpzj5zdfnpj7xa0vzwjyy6nep7fnf3s02cns")

    def test_owner_addresses_have_their_formats(self):
        """USDC: 0x + 40 hex (Ethereum). BTC: lowercase bech32 bc1q (native SegWit)."""
        import re
        info = package._build_module().donate_info()
        self.assertRegex(info["usdc_erc20"], r"^0x[0-9a-fA-F]{40}$")
        self.assertRegex(info["btc"], r"^bc1q[02-9ac-hj-np-z]{38}(?:[02-9ac-hj-np-z]{20})?$")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    res = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(suite)
    if res.wasSuccessful():
        print("RESULT OK %d passed" % res.testsRun)
        sys.exit(0)
    print("RESULT FAIL")
    sys.exit(1)
