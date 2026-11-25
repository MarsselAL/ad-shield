#!/usr/bin/env python3
"""Cold-worker cost of the site cosmetic data, old layout vs the sharded one (offline).

    python3 -I tools/bench_site_data.py

A service worker that wakes for a page's `as-page` message has an empty cache, so it reads and
parses everything the lookup needs. Old layout (up to 2.0.3): rules/cosmetic/site.json (whole,
rebuilt here from the shards) for every page, plus rules/cosmetic/generic.json for hosts with
generic exceptions. New layout (tools/cosmetic.py): one rules/cosmetic/site/<shard>.json per page,
plus rules/cosmetic/generic_excepted.json for exception hosts; worker start (content-script
registration) reads site/index.json instead of site.json.

Prints bytes read and parse time per sample host: Python json.loads, and JavaScriptCore
JSON.parse (what the worker does) when macOS jsc is available. Times are medians of RUNS runs.
"""
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cosmetic as CO  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CDIR = os.path.join(ROOT, "rules", "cosmetic")
JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
RUNS = 15


def read(rel):
    with open(os.path.join(CDIR, rel), encoding="utf-8") as fh:
        return fh.read()


def old_site_text():
    site = CO.read_site(CDIR)
    site.pop("genericFullHosts", None)
    return json.dumps(site, separators=(",", ":"), ensure_ascii=False)


def needs_generic(host, site):
    cands = [".".join(host.split(".")[i:]) for i in range(host.count(".") + 1)]
    if any(c in site["generichide"] or c in site["elemhide"] for c in cands):
        return False
    return any(c in site["genericExceptionHosts"] for c in cands)


def samples(site):
    with_rules = "www.1news.co.nz"
    without = "www.example.org"
    exc = site["genericExceptionHosts"][0]
    return [("site rules", with_rules), ("no rules", without), ("generic exception", exc)]


def plans(site, old_text):
    """{case: (old [(name, text)], new [(name, text)])}"""
    out = {}
    generic, excepted = read("generic.json"), read("generic_excepted.json")
    for label, host in samples(site):
        old = [("site.json", old_text)]
        name = CO.shard_name(CO.shard_of(host)) + ".json"
        new = [("site/" + name, read(os.path.join("site", name)))]
        if needs_generic(host, site):
            old.append(("generic.json", generic))
            new.append(("generic_excepted.json", excepted))
        out["page %s (%s)" % (host, label)] = (old, new)
    out["worker start: registration"] = ([("site.json", old_text)], [("site/index.json", read(os.path.join("site", "index.json")))])
    return out


def py_ms(texts):
    times = []
    for _ in range(RUNS):
        t = time.perf_counter()
        for _, text in texts:
            json.loads(text)
        times.append((time.perf_counter() - t) * 1000)
    return statistics.median(times)


def jsc_ms(cases):
    """{case: (old_ms, new_ms)} from JavaScriptCore, or None."""
    if not os.path.exists(JSC):
        return None
    tmp = tempfile.mkdtemp(prefix="adbrake-bench-")
    files, spec = {}, {}
    for case, (old, new) in cases.items():
        spec[case] = []
        for side in (old, new):
            paths = []
            for name, text in side:
                key = name.replace("/", "_")
                if key not in files:
                    files[key] = os.path.join(tmp, key)
                    with open(files[key], "w", encoding="utf-8") as fh:
                        fh.write(text)
                paths.append(files[key])
            spec[case].append(paths)
    js = """
var spec = %s, out = {};
function med(a) { a.sort(function (x, y) { return x - y; }); return a[a.length >> 1]; }
Object.keys(spec).forEach(function (c) {
  out[c] = spec[c].map(function (paths) {
    var texts = paths.map(function (p) { return readFile(p); }), t = [];
    for (var r = 0; r < %d; r++) {
      var s = preciseTime();
      texts.forEach(function (x) { JSON.parse(x); });
      t.push((preciseTime() - s) * 1000);
    }
    return med(t);
  });
});
print(JSON.stringify(out));
""" % (json.dumps(spec), RUNS)
    script = os.path.join(tmp, "bench.js")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(js)
    try:
        res = subprocess.run([JSC, script], capture_output=True, text=True, timeout=300)
        return json.loads(res.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def main():
    site = CO.read_site(CDIR)
    old_text = old_site_text()
    cases = plans(site, old_text)
    js = jsc_ms(cases)
    print("%-52s %12s %12s %10s %10s %10s %10s" % ("cold lookup", "old bytes", "new bytes", "old py ms", "new py ms",
                                                   "old jsc ms", "new jsc ms"))
    for case, (old, new) in cases.items():
        ob = sum(len(t.encode("utf-8")) for _, t in old)
        nb = sum(len(t.encode("utf-8")) for _, t in new)
        oj, nj = (js or {}).get(case, [None, None])
        print("%-52s %12d %12d %10.2f %10.2f %10s %10s" % (case, ob, nb, py_ms(old), py_ms(new),
                                                       "%.2f" % oj if oj is not None else "-",
                                                       "%.2f" % nj if nj is not None else "-"))
        print("    old: %s | new: %s" % (" + ".join(n for n, _ in old), " + ".join(n for n, _ in new)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
