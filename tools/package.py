#!/usr/bin/env python3
"""Build the zip that is the way to share Ad Shield (free; no store listing).

    python3 -I tools/package.py        ->  dist/ad-shield-<version>.zip

Rebuilds the bundles first (tools/build.py), then zips, under one top folder "ad-shield/", only
what the browser needs at run time: manifest.json, build/, src/, rules/, vendor/, icons/,
LICENSE, NOTICE.md, plus INSTALL.txt (copied from docs/INSTALL.txt: install, update and
uninstall steps for Chrome, Edge and Brave on Windows and macOS).
Never included: tests/, tools/, results/, dist/, the rest of docs/, dotfiles, Python caches.
"""
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = "ad-shield"
INCLUDE = ["manifest.json", "LICENSE", "NOTICE.md", "build", "src", "rules", "vendor", "icons"]
# (source in the repo, name in the zip root)
EXTRA = [("docs/INSTALL.txt", "INSTALL.txt")]
SKIP_DIRS = {"tests", "tools", "results", "dist", "docs", "__pycache__", "_metadata", ".git", ".claude"}


def files_to_zip(root=ROOT):
    """[(path on disk, name inside the zip)], sorted, without the skipped folders and dotfiles."""
    out = []
    for item in INCLUDE:
        path = os.path.join(root, item)
        if os.path.isfile(path):
            out.append((path, TOP + "/" + item))
            continue
        for d, dirs, files in os.walk(path):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
            for f in sorted(files):
                if f.startswith(".") or f.endswith(".pyc"):
                    continue
                full = os.path.join(d, f)
                out.append((full, TOP + "/" + os.path.relpath(full, root).replace(os.sep, "/")))
    for src, name in EXTRA:
        out.append((os.path.join(root, src), TOP + "/" + name))
    return out


def build_zip(out, root=ROOT):
    """Write the zip to `out`; returns the number of files."""
    entries = files_to_zip(root)
    missing = [p for p, _ in entries if not os.path.isfile(p)]
    if missing:
        raise FileNotFoundError("missing: %s" % ", ".join(missing))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path, name in entries:
            z.write(path, name)
    return len(entries)


def main():
    subprocess.check_call([sys.executable, "-I", os.path.join(ROOT, "tools", "build.py")])
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
        version = json.load(fh)["version"]
    out = os.path.join(ROOT, "dist", "ad-shield-%s.zip" % version)
    count = build_zip(out)
    print("wrote %s (%d files); share it with %s/INSTALL.txt inside" % (os.path.relpath(out, ROOT), count, TOP))
    return 0


if __name__ == "__main__":
    sys.exit(main())
