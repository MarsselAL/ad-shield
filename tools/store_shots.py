#!/usr/bin/env python3
"""Make the store images from the REAL extension (standard library + Google Chrome only).

    python3 -I tools/store_shots.py [--site URL] [--out docs/store/images]

1. Launches Chrome headless with a throwaway profile, loads this folder unpacked
   (CDP Extensions.loadUnpacked, the same pipe client as tools/live_test.py).
2. Opens a real web page (default: a news site), waits for it to load, then opens the popup
   (popup.html, two panels, 630 px wide) as a background tab in the same window, so the popup reads
   the news tab as "the current tab" and shows its real counts. Captures the popup (light and
   dark) and the settings page (as it is, a store variant, and dark) at 2x. Store variants show
   no third-party names: the page's host reads news.example.com, the popup's tip button (its
   label names payment wallets) and settings rows naming other companies are hidden.
3. Writes the composition pages (docs/store/images/src/make_pages.py) and renders them into
   1280x800 screenshots, a 440x280 small promo tile and a 1400x560 marquee (same Chrome).
   --compose-only skips step 1-2 and reuses the captures in <out>/raw/.

Raw captures are written to <out>/raw/. Nothing is sent anywhere except the page load itself.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import live_test as lt  # noqa: E402

DEFAULT_SITE = "https://www.cnn.com"
POPUP_W = 630  # src/popup/popup.css: body width


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
                                                          "value": "dark" if dark else "light"},
                                                         # still images: no transitions caught half way
                                                         {"name": "prefers-reduced-motion", "value": "reduce"}]},
             session=sid)


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
        # The popup is two panels side by side (controls | Support AdBrake), 630 px wide.
        # Store variant: the page's host name is shown as news.example.com and the tip button, whose
        # label names payment wallets, is hidden with its row, so the images name no third-party brand
        # (docs/store/review-risks.md). The counts are what the popup really counted on that page.
        for dark in (False, True):
            tid = cdp.send("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
            sid = lt.attach(cdp, tid)
            cdp.send("Page.enable", session=sid)
            metrics(cdp, sid, POPUP_W, 600, dark=dark)
            cdp.send("Page.navigate", {"url": base + "src/popup/popup.html"}, session=sid)
            wait_load(cdp, sid)
            time.sleep(2.5)
            info = cdp.evaluate(sid, "['g-ads','g-trackers','g-banners','g-cookies','site-host']"
                                     ".map(id => id + '=' + document.getElementById(id).textContent)")
            print("popup", "dark" if dark else "light", info)
            # Hide the whole tip-button row (not just the button), so the panel closes up with no gap.
            cdp.evaluate(sid, """(() => {
                document.getElementById('site-host').textContent = 'news.example.com';
                const s = document.createElement('style');
                s.textContent = '#support-revolut { display: none !important; }';
                document.head.appendChild(s);
            })()""")
            time.sleep(0.8)
            box = cdp.evaluate(sid, "(() => { const r = document.body.getBoundingClientRect();"
                                    " return {w: Math.ceil(r.width), h: Math.ceil(r.height)}; })()")
            print("popup size", box)
            # Light: the default Phone view, and the USDC view picked with the popup's own control.
            views = [("", None)] if dark else [("", None), ("-usdc", "tab-usdc")]
            for suffix, tab in views:
                if tab:
                    cdp.evaluate(sid, "document.getElementById('%s').click()" % tab)
                    time.sleep(1.5)
                shot(cdp, sid, os.path.join(out_raw, "popup-%s%s.png" % ("dark" if dark else "light", suffix)),
                     clip={"x": 0, "y": 0, "width": box["w"], "height": box["h"]})
            cdp.send("Target.closeTarget", {"targetId": tid})

        # 3. Settings page (light and dark), full height, plus section offsets for cropping.
        # Store variant: example rules saved with the page's own Save buttons (throwaway profile);
        # rows and sections that name other companies (video sites, payment wallets) and the crypto
        # addresses are hidden, and brand names in the grey help text are cut out
        # (docs/store/review-risks.md, risk 6). Everything shown is real UI.
        scrub = """(() => {
            const set = (id, v) => { const t = document.getElementById(id); t.value = v;
              t.dispatchEvent(new Event('input', {bubbles: true}));
              t.closest('section').querySelector('button').click(); };
            set('allowlist', 'bank.example.com\\nintranet.example.org');
            set('userfilters', 'example.com##.newsletter-popup\\nexample.org##.sidebar-promo\\nnews.example.net##.autoplay-video');
            const s = document.createElement('style');
            s.textContent = '#support-usdc, #support-btc, #sec-order, #sec-stats, #sec-lists { display: none !important; }';
            document.head.appendChild(s);
            document.querySelectorAll('.muted').forEach(e => {
              e.textContent = e.textContent.replace(/ and on Twitch/, '').replace(/, including the Twitch features on twitch\\.tv/, '');
            });
            document.querySelectorAll('.muted').forEach(e => {
              e.textContent = e.textContent.replace(/ \\(taken from EasyPrivacy\\)/, '');
            });
            document.querySelectorAll('.muted').forEach(e => {
              e.textContent = e.textContent.replace(/ \\((EasyList|EasyPrivacy|EasyList Cookie List|DuckDuckGo autoconsent)\\)/g, '');
            });
            const brand = /YouTube|Twitch|Apple|Google|DuckDuckGo|Revolut/;
            document.querySelectorAll('.opt, .nav-row, .caption, main > section').forEach(e => {
              const own = e.matches('main > section') ? (e.querySelector('h2') || {}).textContent || '' : e.textContent;
              if (brand.test(own)) e.style.display = 'none'; });
            document.querySelectorAll('.opt strong').forEach(e => {
              e.textContent = e.textContent.split(', fbclid, gclid').join(''); });
        })()"""
        boxjs = """(() => { const o = {};
            document.querySelectorAll('main > header, main > section, main > nav').forEach((s, i) => {
              if (getComputedStyle(s).display === 'none') return;
              const r = s.getBoundingClientRect(); const h = s.querySelector('h2');
              const k = h ? h.textContent : (s.tagName === 'NAV' ? 'More settings' : 'header');
              o[k] = {x: r.x, y: r.y + scrollY, width: r.width, height: r.height}; });
            o._page = {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight};
            return o; })()"""
        for dark in (False, True):
            tid, sid = lt.open_page(cdp, base + "src/options/options.html")
            metrics(cdp, sid, 760, 900, dark=dark)
            cdp.send("Page.reload", session=sid)
            wait_load(cdp, sid)
            time.sleep(2.5)
            names = ["options-dark"] if dark else ["options-light", "options-store-light"]
            for name in names:
                if name != "options-light":  # options-light is the page as it is, for reference
                    cdp.evaluate(sid, scrub)
                    time.sleep(1.5)
                # Viewport as tall as the page, so the fixed background covers all of it.
                full_h = cdp.evaluate(sid, "document.documentElement.scrollHeight")
                metrics(cdp, sid, 760, full_h, dark=dark)
                time.sleep(1)
                boxes = cdp.evaluate(sid, boxjs)
                with open(os.path.join(out_raw, name + ".json"), "w") as fh:
                    json.dump(boxes, fh, indent=1)
                shot(cdp, sid, os.path.join(out_raw, name + ".png"),
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
    # The composition pages read the section positions written at capture.
    subprocess.run([sys.executable, "-I", os.path.join(a.out, "src", "make_pages.py")], check=True)
    render_compositions(os.path.join(a.out, "src"), a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
