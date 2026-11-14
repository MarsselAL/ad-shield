#!/usr/bin/env python3
"""Tests for tools/package.py: the zip has INSTALL.txt and manifest.json under ad-shield/ and no
tests, tools, results or other docs.

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
            self.assertEqual(self.install, fh.read())
        for words in ("chrome://extensions", "edge://extensions", "brave://extensions", "Developer mode", "Load unpacked",
                      "macOS", "Windows", "permanent", "reload", "pin", "Settings", "week", "Remove", "Disable"):
            self.assertIn(words, self.install, words)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    res = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(suite)
    if res.wasSuccessful():
        print("RESULT OK %d passed" % res.testsRun)
        sys.exit(0)
    print("RESULT FAIL")
    sys.exit(1)
