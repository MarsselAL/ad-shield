#!/usr/bin/env python3
"""Vendor DuckDuckGo autoconsent (MPL-2.0) into vendor/autoconsent/, unmodified.

    python3 -I tools/vendor_autoconsent.py

Downloads the pinned npm release tarball with curl into a fresh temporary folder, checks its
sha512 integrity against the value published by the npm registry (pinned below), and copies
only these files out of it, byte for byte:
    package/dist/addon-mv3/content.bundle.js   content script (all frames, ISOLATED world)
    package/dist/addon-mv3/compact-rules.json  CMP rules sent to the content script on "init"
    package/dist/autoconsent.cjs.js            library build; the background uses its
                                               evalSnippets and filterCompactRules exports
    package/LICENSE                            MPL-2.0 text
and writes vendor/autoconsent/VERSION.json (version, tarball URL, integrity, file hashes).
To update: change VERSION and INTEGRITY (from https://registry.npmjs.org/@duckduckgo/autoconsent),
run this script, run bash tests/run.sh, reload the extension and test a few cookie banners.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = "18.11.0"  # published 2026-11-25
INTEGRITY = "sha512-kaIyKo5mRGbCqH5yP8IYfj81uo2p9f4koWTfc7TVuZirIsSQIXKQ0Q+oooLGa14VIlajeR3iV5lywpQIALDA2w=="
TARBALL = "https://registry.npmjs.org/@duckduckgo/autoconsent/-/autoconsent-%s.tgz" % VERSION
FILES = {
    "package/dist/addon-mv3/content.bundle.js": "content.bundle.js",
    "package/dist/addon-mv3/compact-rules.json": "compact-rules.json",
    "package/dist/autoconsent.cjs.js": "autoconsent.cjs.js",
    "package/LICENSE": "LICENSE",
}


def main():
    tmp = tempfile.mkdtemp(prefix="adshield-autoconsent-")
    tgz = os.path.join(tmp, "autoconsent.tgz")
    subprocess.check_call(["curl", "-fsSL", "--max-time", "120", "--proto", "=https", "-o", tgz, TARBALL])
    data = open(tgz, "rb").read()
    got = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if got != INTEGRITY:
        print("integrity mismatch:", got)
        return 1
    out = os.path.join(ROOT, "vendor", "autoconsent")
    os.makedirs(out, exist_ok=True)
    hashes = {}
    with tarfile.open(tgz, "r:gz") as tar:
        for member, name in FILES.items():
            info = tar.getmember(member)
            if not info.isfile():
                print("not a regular file:", member)
                return 1
            content = tar.extractfile(info).read()
            with open(os.path.join(out, name), "wb") as fh:
                fh.write(content)
            hashes[name] = hashlib.sha256(content).hexdigest()
    with open(os.path.join(out, "VERSION.json"), "w", encoding="utf-8") as fh:
        json.dump({"package": "@duckduckgo/autoconsent", "version": VERSION, "tarball": TARBALL,
                   "integrity": INTEGRITY, "licence": "MPL-2.0", "modified": False, "sha256": hashes},
                  fh, indent=2, sort_keys=True)
        fh.write("\n")
    print("vendored @duckduckgo/autoconsent", VERSION, "->", os.path.relpath(out, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
