#!/usr/bin/env python3
"""Real-browser checks for the Phase 1 privacy and speed changes (2026-11-25).

    python3 -I tools/phase1_check.py

Throwaway headless Chrome with the unpacked extension (CDP pipe client from tools/live_test.py).
Pages are served from 127.0.0.1; the only outside traffic is (c) example.org after the AMP unwrap,
and (b)'s script URLs, which DNR redirects to packaged surrogates before any request leaves.
  (a) GPC: the page load reaches the local server with "Sec-GPC: 1"; navigator.globalPrivacyControl
      is true in the top frame and in an iframe.
  (b) Surrogates: a page loading gtag/js, gtm.js, analytics.js, ga.js, gpt.js, adsbygoogle.js and
      ima3.js from their real URLs and calling gtag(), dataLayer eventCallback, ga(), _gaq.push,
      googletag.cmd.push, adsbygoogle.push and new google.ima.AdDisplayContainer runs with no
      exception; each script is served from chrome-extension://.
  (c) https://www.google.com/amp/s/example.org/ ends at https://example.org/.
  (d) A page with 6 iframes: in the top frame a "core" (every frame) and a "top-only" generic ad
      selector are hidden; in the iframes the core one is hidden too.
Results: results/<timestamp>-phase1/ (report.json, report.md).
"""
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_test as lt  # noqa: E402

ROOT = lt.ROOT
SEEN = []  # (path, Sec-GPC header)


def selectors(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        text = re.sub(r"/\*.*?\*/", "", fh.read(), flags=re.S)
    return [s.strip() for s in text.split("{")[0].split(",")]


CORE = lt.first_simple_selector(selectors("rules/cosmetic/ads_generic.css"))
TOP = lt.first_simple_selector(selectors("rules/cosmetic/ads_generic_top.css"))

PAGES = {
    "/gpc.html": "<!doctype html><title>gpc</title><iframe src='/frame.html'></iframe>",
    "/frame.html": "<!doctype html><title>f</title>%s%s<p id='plain'>x</p>"
                   % (lt.element_html(CORE, "core"), lt.element_html(TOP, "top")),
    "/frames.html": "<!doctype html><title>frames</title>%s%s<p id='plain'>x</p>%s"
                    % (lt.element_html(CORE, "core"), lt.element_html(TOP, "top"),
                       "".join("<iframe src='/frame.html?%d'></iframe>" % i for i in range(6))),
    "/surrogates.html": """<!doctype html><title>s</title>
<script>window.__errs = []; addEventListener('error', function (e) { __errs.push(String(e.message)); });
window.dataLayer = window.dataLayer || []; function gtag(){ dataLayer.push(arguments); }
window._gaq = window._gaq || [];</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script src="https://www.google-analytics.com/ga.js"></script>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script src="https://imasdk.googleapis.com/js/sdkloader/ima3.js"></script>
<ins class="adsbygoogle" style="display:block"></ins>
<div id="gpt-slot"></div>
<script>
window.__out = {};
try { gtag('js', new Date()); gtag('config', 'G-TEST123'); __out.gtag = true; } catch (e) { __errs.push('gtag ' + e); }
try { dataLayer.push({ event: 'x', eventCallback: function () { __out.gtmCallback = true; } }); } catch (e) { __errs.push('dl ' + e); }
try { ga('create', 'UA-1-1', 'auto'); ga('send', 'pageview', { hitCallback: function () { __out.gaHit = true; } }); } catch (e) { __errs.push('ga ' + e); }
try { _gaq.push(['_trackPageview']); __out.gaq = true; } catch (e) { __errs.push('gaq ' + e); }
try { googletag.cmd.push(function () { googletag.defineSlot('/1/x', [300, 250], 'gpt-slot').addService(googletag.pubads());
  googletag.enableServices(); googletag.display('gpt-slot'); __out.gpt = true; }); } catch (e) { __errs.push('gpt ' + e); }
try { (window.adsbygoogle = window.adsbygoogle || []).push({}); __out.adsbygoogle = true; } catch (e) { __errs.push('asg ' + e); }
try { var c = new google.ima.AdDisplayContainer(document.body); c.initialize(); __out.ima = true; } catch (e) { __errs.push('ima ' + e); }
</script>""",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        SEEN.append((self.path, self.headers.get("Sec-GPC")))
        body = PAGES.get(self.path.split("?")[0])
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write((body or "nf").encode())

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True


def wait(cdp, sid, expr, timeout=15):
    end = time.time() + timeout
    v = None
    while time.time() < end:
        try:
            v = cdp.evaluate(sid, expr)
            if v:
                return v
        except lt.CDPError:
            pass
        time.sleep(0.3)
    return v


def frame_eval(cdp, sid, expr):
    """Evaluate expr in every child frame's isolated context via a fresh isolated world."""
    tree = cdp.send("Page.getFrameTree", session=sid)["frameTree"]
    out = []
    for ch in tree.get("childFrames", []):
        ctx = cdp.send("Page.createIsolatedWorld", {"frameId": ch["frame"]["id"], "worldName": "chk"},
                       session=sid)["executionContextId"]
        r = cdp.send("Runtime.evaluate", {"expression": expr, "contextId": ctx, "returnByValue": True}, session=sid)
        out.append(r.get("result", {}).get("value"))
    return out


def main():
    httpd = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    outdir = lt.results_dir("phase1")
    report = {"core_selector": CORE, "top_selector": TOP, "checks": []}

    def check(name, ok, detail):
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print("  %s %s - %s" % ("PASS" if ok else "FAIL", name, json.dumps(detail)[:400]))

    cdp = lt.PipeCDP(lt.LIVE_FLAGS, headless=True)
    try:
        ext_id = lt.load_extension(cdp)
        lt.find_sw_target(cdp, ext_id)
        time.sleep(3)  # settings defaults, ruleset sync, content-script registration

        # (a) GPC
        _, sid = lt.open_page(cdp, base + "/gpc.html")
        wait(cdp, sid, "document.readyState === 'complete'")
        time.sleep(1)
        hdr = [h for p, h in SEEN if p.startswith("/gpc.html")]
        top = cdp.evaluate(sid, "navigator.globalPrivacyControl")
        frames = cdp.evaluate(sid, "[...document.querySelectorAll('iframe')].map(f => f.contentWindow.navigator.globalPrivacyControl)")
        sub_hdr = [h for p, h in SEEN if p.startswith("/frame.html")]
        check("(a) Sec-GPC: 1 on the page load", hdr and hdr[0] == "1", {"page": hdr, "iframe_load": sub_hdr})
        check("(a) navigator.globalPrivacyControl true (top + iframe)", top is True and frames == [True],
              {"top": top, "frames": frames})

        # (b) surrogates
        tid = cdp.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = lt.attach(cdp, tid)
        for m in ("Runtime.enable", "Page.enable", "Network.enable"):
            cdp.send(m, session=sid)
        while not cdp.events.empty():
            cdp.events.get_nowait()
        cdp.send("Page.navigate", {"url": base + "/surrogates.html"}, session=sid)
        wait(cdp, sid, "document.readyState === 'complete'")
        time.sleep(3)
        res = cdp.evaluate(sid, "({ errs: __errs, out: __out })")
        served = {}
        while not cdp.events.empty():
            e = cdp.events.get_nowait()
            if e.get("sessionId") == sid and e.get("method") == "Network.responseReceived" \
                    and e["params"].get("type") == "Script":
                served[e["params"]["requestId"]] = e["params"]["response"]["url"].split("?")[0]
        res["scripts"] = sorted(served.values())
        ext = [u for u in res["scripts"] if u.startswith("chrome-extension://")]
        want = ["gtag", "gaq", "gpt", "adsbygoogle", "ima"]
        check("(b) surrogate pages: no exceptions, calls work", not res["errs"] and all(res["out"].get(k) for k in want),
              {"errors": res["errs"], "out": res["out"]})
        check("(b) all 7 scripts served from the extension", len(ext) >= 7 and len(res["scripts"]) == len(ext),
              {"extension": [u.rsplit("/", 1)[-1] for u in ext],
               "other": [u for u in res["scripts"] if not u.startswith("chrome-extension://")]})

        # (c) AMP unwrap
        _, sid = lt.open_page(cdp, "https://www.google.com/amp/s/example.org/")
        href = wait(cdp, sid, "document.readyState === 'complete' && location.href", timeout=25)
        check("(c) google.com/amp/s/example.org/ unwraps", href == "https://example.org/", href)

        # (d) iframes
        _, sid = lt.open_page(cdp, base + "/frames.html")
        wait(cdp, sid, "document.readyState === 'complete'")
        time.sleep(2)
        disp = "({core: getComputedStyle(document.querySelector('[data-t=core]')).display," \
               " top: getComputedStyle(document.querySelector('[data-t=top]')).display," \
               " plain: getComputedStyle(document.getElementById('plain')).display})"
        topd = cdp.evaluate(sid, disp)
        fr = frame_eval(cdp, sid, disp)
        check("(d) top frame hides core + top-only ad selectors, plain visible",
              topd["core"] == "none" and topd["top"] == "none" and topd["plain"] != "none", topd)
        check("(d) 6 iframes hide the core selector", len(fr) == 6 and all(f and f["core"] == "none" for f in fr), fr)
    finally:
        cdp.close()
        httpd.shutdown()
    ok = all(c["ok"] for c in report["checks"])
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    with open(os.path.join(outdir, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("# Phase 1 browser checks\n\n" + "\n".join(
            "- %s %s: `%s`" % ("PASS" if c["ok"] else "FAIL", c["name"], json.dumps(c["detail"])[:600])
            for c in report["checks"]) + "\n")
    print("PHASE1 %s  (%s)" % ("OK" if ok else "FAIL", os.path.relpath(outdir, ROOT)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
