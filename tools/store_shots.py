#!/usr/bin/env python3
"""Make the store images from the REAL extension (standard library + Google Chrome only).

    python3 -I tools/store_shots.py [--site URL] [--out docs/store/images]

1. Launches Chrome headless with a throwaway profile, loads this folder unpacked
   (CDP Extensions.loadUnpacked, the same pipe client as tools/live_test.py).
2. Opens a real web page (default: a news site), waits for it to load, then opens the popup
   (popup.html) as a background tab in the same window, so the popup reads the news tab as
   "the current tab" and shows its real counts. Captures the popup and the settings page
   (light and dark) at 2x.
3. Composes the captures into 1280x800 screenshots, a 440x280 small promo tile and a
   1400x560 marquee from HTML pages in docs/store/images/src/ (rendered by the same Chrome).

Raw captures are written to <out>/raw/. Nothing is sent anywhere except the page load itself.
"""
import argparse
import base64
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import live_test as lt  # noqa: E402

DEFAULT_SITE = "https://www.cnn.com"


def shot(cdp, sid, path, clip=None, scale=2):
    params = {"format": "png", "captureBeyondViewport": True}
    if clip:
        params["clip"] = dict(clip, scale=1)
    data = cdp.send("Page.captureScreenshot", params, session=sid, timeout=60)["data"]
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(data))
    print("wrote", os.path.relpath(path, ROOT))


def metrics(cdp, sid, w, h, scale=2, dark=False):
    cdp.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": scale,
                                                    "mobile": False}, session=sid)
    cdp.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme",
                                                          "value": "dark" if dark else "light"}]}, session=sid)


def wait_load(cdp, sid, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cdp.evaluate(sid, "document.readyState") == "complete":
                return True
        except lt.CDPError:
            pass
        time.sleep(0.5)
    return False


def capture(out_raw, site):
    cdp = lt.PipeCDP(["--window-size=1280,900", "--lang=en-US", "--accept-lang=en-US,en", "--hide-scrollbars",
                      "--mute-audio"], headless=True)
    try:
        ext = lt.load_extension(cdp, ROOT)
        print("extension", ext)
        time.sleep(2)
        base = "chrome-extension://%s/" % ext

        # 1. A real page, so the popup has real numbers.
        news_tid, news = lt.open_page(cdp, site)
        metrics(cdp, news, 1280, 800, scale=1)
        wait_load(cdp, news, 60)
        time.sleep(12)  # late ad / tracker requests and the cookie banner
        cdp.send("Target.activateTarget", {"targetId": news_tid})

        # 2. Popup as a background tab of the same window: tabs.query({active, currentWindow}) = news tab.
        for dark in (False, True):
            tid = cdp.send("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
            sid = lt.attach(cdp, tid)
            cdp.send("Page.enable", session=sid)
            metrics(cdp, sid, 320, 600, dark=dark)
            cdp.send("Page.navigate", {"url": base + "src/popup/popup.html"}, session=sid)
            wait_load(cdp, sid)
            time.sleep(2.5)
            h = cdp.evaluate(sid, "Math.ceil(document.body.getBoundingClientRect().height)")
            info = cdp.evaluate(sid, "[...document.querySelectorAll('td[id^=g-]')].map(e=>e.id+'='+e.textContent)"
                                     ".concat(document.getElementById('site-host').textContent)")
            print("popup", "dark" if dark else "light", info)
            shot(cdp, sid, os.path.join(out_raw, "popup-%s.png" % ("dark" if dark else "light")),
                 clip={"x": 0, "y": 0, "width": 320, "height": h})
            cdp.send("Target.closeTarget", {"targetId": tid})

        # 3. Settings page (light and dark), full height, plus section offsets for cropping.
        for dark in (False, True):
            tid, sid = lt.open_page(cdp, base + "src/options/options.html")
            metrics(cdp, sid, 760, 900, dark=dark)
            cdp.send("Page.reload", session=sid)
            wait_load(cdp, sid)
            time.sleep(2.5)
            boxes = cdp.evaluate(sid, """(() => {
                const o = {};
                document.querySelectorAll('main > header, main > section').forEach((s, i) => {
                  const r = s.getBoundingClientRect();
                  const h = s.querySelector('h2');
                  o[(h ? h.textContent : 'header') + (o[h ? h.textContent : 'header'] ? i : '')] =
                    {x: r.x, y: r.y + scrollY, width: r.width, height: r.height};
                });
                o._page = {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight};
                return o;
            })()""")
            name = "options-%s" % ("dark" if dark else "light")
            with open(os.path.join(out_raw, name + ".json"), "w") as fh:
                json.dump(boxes, fh, indent=1)
            shot(cdp, sid, os.path.join(out_raw, name + ".png"),
                 clip={"x": 0, "y": 0, "width": boxes["_page"]["width"], "height": boxes["_page"]["height"]})
            if not dark:
                # Store variant: example rules saved with the page's own Save buttons (throwaway
                # profile), and the rows that name other companies' video sites and the crypto
                # addresses hidden (docs/store/review-risks.md, risk 6). Everything shown is real UI.
                cdp.evaluate(sid, """(() => {
                    const set = (id, v, btn) => { const t = document.getElementById(id); t.value = v;
                      t.dispatchEvent(new Event('input', {bubbles: true}));
                      t.closest('section').querySelector('button').click(); };
                    set('allowlist', 'bank.example.com\\nintranet.example.org', true);
                    set('userfilters', 'example.com##.newsletter-popup\\nexample.org##.sidebar-promo\\nnews.example.net##.autoplay-video', true);
                    const s = document.createElement('style');
                    s.textContent = '#support-usdc, #support-btc { display: none !important; }';
                    document.head.appendChild(s);
                    document.querySelectorAll('.opt').forEach(o => { if (/YouTube|Twitch/.test(o.textContent)) o.style.display = 'none'; });
                })()""")
                time.sleep(1.5)
                boxes = cdp.evaluate(sid, """(() => { const o = {};
                    document.querySelectorAll('main > header, main > section').forEach((s, i) => {
                      const r = s.getBoundingClientRect(); const h = s.querySelector('h2');
                      o[h ? h.textContent : 'header'] = {x: r.x, y: r.y + scrollY, width: r.width, height: r.height}; });
                    o._page = {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight};
                    return o; })()""")
                with open(os.path.join(out_raw, "options-store-light.json"), "w") as fh:
                    json.dump(boxes, fh, indent=1)
                shot(cdp, sid, os.path.join(out_raw, "options-store-light.png"),
                     clip={"x": 0, "y": 0, "width": boxes["_page"]["width"], "height": boxes["_page"]["height"]})
            cdp.send("Target.closeTarget", {"targetId": tid})
    finally:
        cdp.close()


def render_compositions(src_dir, out_dir):
    """Render every <name>-<w>x<h>.html in src_dir to <out_dir>/<name>.png at that size."""
    cdp = lt.PipeCDP(["--hide-scrollbars", "--allow-file-access-from-files"], headless=True)
    try:
        for f in sorted(os.listdir(src_dir)):
            if not f.endswith(".html") or "-" not in f or "x" not in f.rsplit("-", 1)[1]:
                continue
            name, size = f[:-5].rsplit("-", 1)
            w, h = (int(x) for x in size.split("x"))
            tid, sid = lt.open_page(cdp, "about:blank")
            metrics(cdp, sid, w, h, scale=1)
            cdp.send("Page.navigate", {"url": "file://" + os.path.join(src_dir, f)}, session=sid)
            wait_load(cdp, sid)
            time.sleep(1.5)
            shot(cdp, sid, os.path.join(out_dir, name + ".png"), clip={"x": 0, "y": 0, "width": w, "height": h})
            cdp.send("Target.closeTarget", {"targetId": tid})
    finally:
        cdp.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=DEFAULT_SITE)
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "store", "images"))
    ap.add_argument("--compose-only", action="store_true")
    a = ap.parse_args()
    raw = os.path.join(a.out, "raw")
    os.makedirs(raw, exist_ok=True)
    if not a.compose_only:
        capture(raw, a.site)
    render_compositions(os.path.join(a.out, "src"), a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
