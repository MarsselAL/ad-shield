#!/usr/bin/env python3
"""Build a zip of the extension for installing on another computer.

    python3 tools/package.py        ->  dist/ad-shield-<version>.zip

Rebuilds the bundles first (tools/build.py), then zips only what Chrome needs at runtime:
manifest.json, build/, src/ (service worker, popup, options), rules/, vendor/, icons/,
LICENSE, NOTICE.md.
On the other computer: unzip, open chrome://extensions, turn on Developer mode,
"Load unpacked" and pick the unzipped folder (the one that contains manifest.json).
"""
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE = ["manifest.json", "LICENSE", "NOTICE.md", "build", "src", "rules", "vendor", "icons"]

subprocess.check_call([sys.executable, "-I", os.path.join(ROOT, "tools", "build.py")])
with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
    version = json.load(fh)["version"]
out = os.path.join(ROOT, "dist", "ad-shield-%s.zip" % version)
os.makedirs(os.path.dirname(out), exist_ok=True)
top = "ad-shield"
count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            z.write(path, os.path.join(top, item)); count += 1
            continue
        for d, _, files in os.walk(path):
            for f in sorted(files):
                if f.startswith("."):
                    continue
                full = os.path.join(d, f)
                z.write(full, os.path.join(top, os.path.relpath(full, ROOT))); count += 1
print("wrote %s (%d files)" % (os.path.relpath(out, ROOT), count))
