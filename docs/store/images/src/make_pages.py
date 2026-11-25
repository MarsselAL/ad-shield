#!/usr/bin/env python3
"""Writes the composition pages (<name>-<w>x<h>.html) that tools/store_shots.py renders.
All screenshots inside are the real captures in ../raw/ (popup and settings page); section
positions come from the settings page's own layout (../raw/options-*.json, written at capture).
tools/store_shots.py runs this before rendering; it can also be run on its own.

No third-party brand names in any headline, caption or bullet (the first store submission was
rejected for keyword spam: docs/store/review-risks.md)."""
import json
import os
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(os.path.dirname(HERE), "raw")
HEAD = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>'
VERSION = "2.0.3"
POPUP_W = 630  # CSS width of the popup capture (src/popup/popup.css)
PAGE_W = 760   # CSS width of the settings page capture


def boxes(name):
    """Section boxes of a settings capture: {"General": {"y":.., "height":..}, ...}."""
    try:
        with open(os.path.join(RAW, name + ".json")) as fh:
            return json.load(fh)
    except OSError:
        return {}


def span(b, first, last, pad=0):
    """CSS y range from the top of section `first` to the bottom of section `last`."""
    return b[first]["y"] - pad, b[last]["y"] + b[last]["height"] + pad


def crop(img, y0, y1, s, x0=20, x1=740, page_w=PAGE_W, bar=None, extra=""):
    """A window onto a settings capture: CSS box (x0, y0)-(x1, y1) at scale s, with an optional title bar."""
    w, h = (x1 - x0) * s, (y1 - y0) * s
    b = '<div class="bar"><i></i><i></i><i></i><span>%s</span></div>' % bar if bar else ""
    return ('<div class="card" style="width:%dpx;%s">%s<div class="crop" style="width:%dpx;height:%dpx">'
            '<img src="../raw/%s" style="width:%dpx;left:%dpx;top:%dpx"></div></div>'
            % (w, extra, b, w, h, img, page_w * s, -x0 * s, -y0 * s))


def popup(img, width, extra=""):
    """The whole popup capture (both panels) at the given width."""
    return ('<div class="card popup" style="width:%dpx;%s"><img src="../raw/%s" style="width:100%%;display:block">'
            '</div>' % (width, extra, img))


def pcrop(img, x0, y0, x1, y1, s, extra=""):
    """A window onto the popup capture: CSS box (x0, y0)-(x1, y1) at scale s."""
    return crop(img, y0, y1, s, x0=x0, x1=x1, page_w=POPUP_W, extra="border-radius:22px;" + extra)


def text(h1, sub, pts, cls=""):
    li = "".join("<li>%s</li>" % p for p in pts)
    return ('<div class="text %s"><div class="brand"><img src="icon128.png">AdBrake</div><h1>%s</h1>'
            '<p class="sub">%s</p><ul class="pts">%s</ul></div>' % (cls, h1, sub, li))


def page(name, body, cls=""):
    with open(os.path.join(HERE, name), "w") as fh:
        fh.write(HEAD + '<body class="%s">%s</body></html>' % (cls, body))


NOTE = '<div class="note">Real capture of AdBrake %s</div>' % VERSION
L = boxes("options-store-light")
D = boxes("options-dark")

# 1. The popup, both panels, at a little over its real size.
page("shot-1-popup-1280x800.html", '<div class="wrap hero">' + text(
    "Blocks ads, trackers and cookie banners",
    "On every site, from the moment you install it.",
    ["See what was blocked on this page", "Cookie banners hidden; auto-reject optional",
     "Hide any page element with one click", "One switch per site"], cls="narrow") +
    '<div class="stage">' + popup("popup-light.png", 764) + '</div></div>' + NOTE)

# 2. Settings: the General and All sites switches.
y0, y1 = span(L, "General", "All sites", 6)
page("shot-2-settings-1280x800.html", '<div class="wrap">' + text(
    "Every feature is a switch",
    "Turn ads, trackers, cookie banners and link-tracking clean-up on or off. Settings stay on your device.",
    ["No account, no sign-in", "Changes apply right away", "Built-in lists work offline"]) +
    '<div class="stage">' + crop("options-store-light.png", y0, y1, min(0.86, 640.0 / (y1 - y0)),
                                 bar="AdBrake settings") + '</div></div>' + NOTE)

# 3. Per-site control: allowlist and own filters in settings, the popup's site card and quick actions.
y0, y1 = span(L, "Sites where blocking is off", "My filters", 6)
s3 = min(0.8, 600.0 / (y1 - y0))
page("shot-3-filters-1280x800.html", '<div class="wrap">' + text(
    "Hide anything, per site",
    "Click “Hide element”, point at it, done. Turn blocking off for sites you trust.",
    ["Point and click to hide an element", "Allow a site with one switch", "Edit your own rules any time"]) +
    '<div class="stage"><div class="stack" style="width:640px;height:%dpx">' % (34 + (y1 - y0) * s3 + 70) +
    '<div style="position:absolute;right:0;top:0">' + crop("options-store-light.png", y0, y1, s3, bar="AdBrake settings") + '</div>'
    '<div style="position:absolute;left:-30px;bottom:0">' + pcrop("popup-light.png", 16, 286, 334, 406, 1.1) + '</div>'
    '</div></div></div>' + NOTE)

# 4. Privacy, in dark mode: the popup as the dark theme shows it.
page("shot-4-privacy-1280x800.html", '<div class="wrap">' + text(
    "No telemetry. Open source.",
    "AdBrake sends nothing about you anywhere. The only downloads are the public filter lists, once a week.",
    ["MIT licence, source code public", "No analytics, no remote config", "Free, with no paid tier"]) +
    '<div class="stage">' + popup("popup-dark.png", 640) + '</div></div>' + NOTE, cls="dark")

# 5. Support: the popup's support panel, with the USDC view picked in its Phone | USDC | BTC control.
page("shot-5-support-1280x800.html", '<div class="wrap">' + text(
    "Free for everyone",
    "Every feature is free, with no ads of its own and no upsell. If it saves you time, an optional tip helps keep it going.",
    ["Nothing is locked behind a payment", "Tips are optional; reminders can be turned off",
     "Filter lists update by themselves"]) +
    '<div class="stage">' + pcrop("popup-light-usdc.png", 346, 6, 624, 419, 1.38) + '</div></div>' + NOTE)

# 440x280 small promo tile
page("promo-small-440x280.html", '<div style="position:absolute;inset:0;background:linear-gradient(150deg,#e5222e,#a5121c);'
     'display:flex;flex-direction:column;justify-content:center;padding:0 34px;color:#fff">'
     '<div style="display:flex;align-items:center;gap:16px"><div style="width:84px;height:84px;border-radius:22px;background:#fff;display:flex;align-items:center;justify-content:center;'
     'box-shadow:0 8px 20px rgba(0,0,0,.22)"><img src="icon128.png" style="width:64px;height:64px"></div><div style="font-size:44px;font-weight:800;'
     'letter-spacing:-.02em">AdBrake</div></div><div style="margin-top:18px;font-size:20px;line-height:1.35;'
     'color:#ffe3e5;font-weight:500">Blocks ads, trackers<br>and cookie banners.<br><span style=\'color:#fff;font-weight:700\'>Free. Open source. No telemetry.</span></div></div>')

# 1400x560 marquee
page("promo-marquee-1400x560.html", '<div style="position:absolute;inset:0;background:radial-gradient(900px 500px at 80% 30%,#ff6874 0%,rgba(255,104,116,0) 65%),'
     'linear-gradient(150deg,#e5222e,#8f0f19);color:#fff"></div><div class="wrap" style="padding:0 70px;gap:44px">'
     '<div style="flex:0 0 560px;color:#fff"><div style="display:flex;align-items:center;gap:18px"><div style="width:96px;height:96px;border-radius:26px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(0,0,0,.22)"><img src="icon128.png" style="width:74px;height:74px"></div>'
     '<div style="font-size:56px;font-weight:800;letter-spacing:-.02em">AdBrake</div></div>'
     '<div style="margin-top:26px;font-size:34px;font-weight:700;line-height:1.2">Blocks ads, trackers and cookie banners on every site.</div>'
     '<div style="margin-top:16px;font-size:22px;color:#ffe3e5">Free. Open source. No telemetry.</div></div>'
     '<div class="stage">' + popup("popup-light.png", 656) + '</div></div>')
