#!/usr/bin/env python3
"""Run https://superadblocktest.com/ in a throwaway Chrome, with and/or without Ad Shield.

Usage:
    python3 -I tools/site_test.py                 # with the extension, then without
    python3 -I tools/site_test.py --only ext      # with the extension only
    python3 -I tools/site_test.py --only noext    # baseline only

Reuses the CDP pipe client from tools/live_test.py (fresh profile, quiet flags, extension
loaded with Extensions.loadUnpacked). Clicks the page's own "Start test" button (#retest),
waits until every probe row has a status, then reads every row (category, group, host,
blocked/accessible) and the page's "Overall Protection Score" / "Raw Block Rate" text.

The score is recomputed from the rows with the page's own module weights (SCORE_MODULES /
MODULE_WEIGHTS in its adblock.js, copied below; checked 2026-11-14), so the two can be
compared. Results go to results/<timestamp>-superadblocktest/ (report.json, report.md,
screenshots). This sends real traffic to the test site and to the probed ad/tracker hosts.
"""
import argparse
import base64
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_test as lt  # noqa: E402

URL = "https://superadblocktest.com/"

# From the page's adblock.js (2026-11-14). Categories not listed are shown but not scored.
SCORE_MODULES = {
    "Ad Network Blocking": ["Ads"],
    "Tracker Blocking": ["Analytics", "Tracking & Fingerprinting", "Social Trackers", "Email Tracking & Live Chat"],
    "Video Ad Blocking": ["Video Ads"],
    "Affiliate / Redirect Blocking": ["Affiliate Networks"],
    "Telemetry / OEM Blocking": ["OEM Vendors"],
    "Consent / Experiment Blocking": ["Consent Management", "A/B Testing"],
    "Advanced Risky Host Checks": ["Advanced / Risky Host Checks"],
}
MODULE_WEIGHTS = {
    "Ad Network Blocking": 25, "Tracker Blocking": 25, "Video Ad Blocking": 10,
    "Affiliate / Redirect Blocking": 5, "Telemetry / OEM Blocking": 5,
    "Consent / Experiment Blocking": 5, "Advanced Risky Host Checks": 5,
}

READ_ROWS = r"""(() => {
  const rows = [...document.querySelectorAll('.adblockHostDiv')].map(r => ({
    category: r.dataset.category, group: r.dataset.group, host: r.dataset.label,
    status: r.dataset.status || null}));
  const btn = document.getElementById('retest');
  const dash = document.getElementById('benchmarkDashboard');
  return {rows, running: !!(btn && btn.disabled), dashboard: dash ? dash.innerText : ''};
})()"""


def pct(b, t):
    return round(100 * b / t) if t else 0


def score(rows):
    by_cat = {}
    for r in rows:
        c = by_cat.setdefault(r["category"], [0, 0])
        c[1] += 1
        c[0] += r["status"] == "blocked"
    modules = {}
    for name, cats in SCORE_MODULES.items():
        b = sum(by_cat.get(c, [0, 0])[0] for c in cats)
        t = sum(by_cat.get(c, [0, 0])[1] for c in cats)
        if t:
            modules[name] = {"blocked": b, "total": t, "score": pct(b, t), "weight": MODULE_WEIGHTS[name]}
    w = sum(m["weight"] for m in modules.values())
    weighted = round(sum(m["score"] * m["weight"] for m in modules.values()) / w) if w else 0
    blocked = sum(r["status"] == "blocked" for r in rows)
    return {"weighted": weighted, "raw": pct(blocked, len(rows)), "blocked": blocked, "total": len(rows),
            "modules": modules, "categories": {k: {"blocked": v[0], "total": v[1]} for k, v in by_cat.items()}}


def run_once(with_extension, outdir, timeout=240):
    cdp = lt.PipeCDP(lt.LIVE_FLAGS, headless=True)
    tag = "ext" if with_extension else "noext"
    try:
        ext_id = None
        if with_extension:
            ext_id = lt.load_extension(cdp)
            lt.find_sw_target(cdp, ext_id)
            time.sleep(4)  # let the service worker apply rulesets and register content scripts
        tid, sid = lt.open_page(cdp, URL)
        time.sleep(8)
        cdp.evaluate(sid, "document.getElementById('retest').click(), true")
        end = time.time() + timeout
        data = None
        while time.time() < end:
            time.sleep(3)
            data = cdp.evaluate(sid, READ_ROWS)
            if data["rows"] and not data["running"] and all(r["status"] for r in data["rows"]):
                break
        time.sleep(2)
        data = cdp.evaluate(sid, READ_ROWS)
        shot = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True}, session=sid)
        with open(os.path.join(outdir, tag + ".png"), "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        dash = data["dashboard"]
        m = re.search(r"Overall Protection Score\s*(\d+)%", dash, re.I)
        r = re.search(r"Raw Block Rate\s*(\d+)%", dash, re.I)
        return {"withExtension": with_extension, "extensionId": ext_id, "rows": data["rows"],
                "complete": all(x["status"] for x in data["rows"]) and not data["running"],
                "pageScore": int(m.group(1)) if m else None, "pageRaw": int(r.group(1)) if r else None,
                "dashboard": dash, "score": score(data["rows"])}
    finally:
        cdp.close()


def write_md(outdir, runs):
    lines = ["# superadblocktest.com run %s" % os.path.basename(outdir), ""]
    for run in runs:
        s = run["score"]
        lines.append("## %s: page score %s%%, raw %s%% (recomputed %s%% / %s%%, %d/%d blocked)" % (
            "With Ad Shield" if run["withExtension"] else "Without extension",
            run["pageScore"], run["pageRaw"], s["weighted"], s["raw"], s["blocked"], s["total"]))
        lines.append("")
        lines.append("| Module | Blocked | Score | Weight |")
        lines.append("|---|---|---|---|")
        for name, m in s["modules"].items():
            lines.append("| %s | %d/%d | %d%% | %d |" % (name, m["blocked"], m["total"], m["score"], m["weight"]))
        lines.append("")
        lines.append("| Category | Blocked |")
        lines.append("|---|---|")
        for name, c in s["categories"].items():
            lines.append("| %s | %d/%d |" % (name, c["blocked"], c["total"]))
        lines.append("")
        lines.append("Reachable (not blocked):")
        lines.append("")
        for row in run["rows"]:
            if row["status"] != "blocked":
                lines.append("- %s / %s: `%s`" % (row["category"], row["group"], row["host"]))
        lines.append("")
    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write("\n".join(lines))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=["ext", "noext"])
    args = ap.parse_args(argv)
    outdir = lt.results_dir("superadblocktest")
    runs = []
    for with_ext in (True, False):
        if args.only and args.only != ("ext" if with_ext else "noext"):
            continue
        runs.append(run_once(with_ext, outdir))
        s = runs[-1]["score"]
        print("%s: page %s%% raw %s%% | recomputed %s%% raw %s%% (%d/%d)%s" % (
            "ext" if with_ext else "noext", runs[-1]["pageScore"], runs[-1]["pageRaw"], s["weighted"], s["raw"],
            s["blocked"], s["total"], "" if runs[-1]["complete"] else " INCOMPLETE"))
    with open(os.path.join(outdir, "report.json"), "w") as f:
        json.dump(runs, f, indent=1)
    write_md(outdir, runs)
    print(outdir)


if __name__ == "__main__":
    main()
