#!/usr/bin/env python3
"""Build the two zips of AdBrake: one to share by hand, one to upload to an extension store.

    python3 -I tools/package.py        ->  dist/adbrake-<version>.zip
                                           dist/adbrake-<version>-store.zip

Rebuilds the bundles first (tools/build.py), then zips only what the browser needs at run time:
manifest.json, build/, src/, rules/, vendor/, icons/, LICENSE, NOTICE.md.

adbrake-<version>.zip (to share): everything under one top folder "adbrake/", plus INSTALL.txt
(copied from docs/INSTALL.txt: install, update and uninstall steps for Chrome, Edge and Brave on
Windows and macOS), with the optional support lines from docs/donate.txt appended.

adbrake-<version>-store.zip (for store upload): the same run-time files with manifest.json at the
zip root (no top folder) and no INSTALL.txt.

Never included in either: tests/, tools/, results/, dist/, the rest of docs/, _metadata/,
dotfiles, Python caches.
"""
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = "adbrake"
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


def _build_module():
    """tools/build.py as a module (for donate_info)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("as_build", os.path.join(ROOT, "tools", "build.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def store_files_to_zip(root=ROOT):
    """[(path on disk, name inside the store zip)]: files_to_zip without INSTALL.txt (and the other
    EXTRA files) and without the top folder, so manifest.json sits at the zip root."""
    extra = {TOP + "/" + name for _, name in EXTRA}
    prefix = TOP + "/"
    return [(path, name[len(prefix):]) for path, name in files_to_zip(root) if name not in extra]


def support_text(info):
    """The lines appended to INSTALL.txt from donate_info(): '' when nothing is set."""
    lines = []
    if info.get("url"):
        lines.append("  Tip via Revolut: " + info["url"])
    if info.get("usdc_erc20"):
        lines.append("  USDC on Ethereum (ERC-20) only: " + info["usdc_erc20"])
    if info.get("btc"):
        lines.append("  BTC on the Bitcoin network only: " + info["btc"])
    if not lines:
        return ""
    text = "Like AdBrake? Optional support:\n" + "\n".join(lines) + "\n"
    if info.get("usdc_erc20") or info.get("btc"):
        text += "Sending other coins or using other networks will lose the funds.\n"
    return text


def _write_zip(out, entries, root, install_name=None):
    missing = [p for p, _ in entries if not os.path.isfile(p)]
    if missing:
        raise FileNotFoundError("missing: %s" % ", ".join(missing))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    support = support_text(_build_module().donate_info(root)) if install_name else ""
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path, name in entries:
            if support and name == install_name:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read().rstrip("\n")
                z.writestr(name, text + "\n\n" + support)
            else:
                z.write(path, name)
    return len(entries)


def build_zip(out, root=ROOT):
    """Write the zip to share (top folder "adbrake/", with INSTALL.txt) to `out`; returns the
    number of files."""
    return _write_zip(out, files_to_zip(root), root, install_name=TOP + "/INSTALL.txt")


def build_store_zip(out, root=ROOT):
    """Write the store upload zip (manifest.json at the root, no INSTALL.txt) to `out`; returns the
    number of files."""
    return _write_zip(out, store_files_to_zip(root), root)


def main():
    subprocess.check_call([sys.executable, "-I", os.path.join(ROOT, "tools", "build.py")])
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
        version = json.load(fh)["version"]
    out = os.path.join(ROOT, "dist", "adbrake-%s.zip" % version)
    count = build_zip(out)
    print("wrote %s (%d files); share it with %s/INSTALL.txt inside" % (os.path.relpath(out, ROOT), count, TOP))
    store = os.path.join(ROOT, "dist", "adbrake-%s-store.zip" % version)
    count = build_store_zip(store)
    print("wrote %s (%d files); upload it to the extension store" % (os.path.relpath(store, ROOT), count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
