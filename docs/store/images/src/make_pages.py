#!/usr/bin/env python3
"""Writes the composition pages (<name>-<w>x<h>.html) that tools/store_shots.py renders.
All screenshots inside are the real captures in ../raw/ (popup and settings page)."""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
HEAD = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>'

def crop(img, y0, y1, s, x0=20, x1=740, page_w=760, bar=None):
    w, h = (x1 - x0) * s, (y1 - y0) * s
    b = '<div class="bar"><i></i><i></i><i></i><span>%s</span></div>' % bar if bar else ""
    return ('<div class="card" style="width:%dpx">%s<div class="crop" style="width:%dpx;height:%dpx">'
            '<img src="../raw/%s" style="width:%dpx;left:%dpx;top:%dpx"></div></div>'
            % (w, b, w, h, img, page_w * s, -x0 * s, -y0 * s))

def popup(img, width):
    return '<div class="card" style="width:%dpx;border-radius:14px"><img src="../raw/%s" style="width:100%%;display:block"></div>' % (width, img)

def text(h1, sub, pts):
    li = "".join("<li>%s</li>" % p for p in pts)
    return ('<div class="text"><div class="brand"><img src="icon128.png">AdBrake</div><h1>%s</h1>'
            '<p class="sub">%s</p><ul class="pts">%s</ul></div>' % (h1, sub, li))

def page(name, body, cls=""):
    with open(os.path.join(HERE, name), "w") as fh:
        fh.write(HEAD + '<body class="%s">%s</body></html>' % (cls, body))

NOTE = '<div class="note">Real capture of AdBrake 2.0.3</div>'

page("shot-1-popup-1280x800.html", '<div class="wrap">' + text(
    "Blocks ads, trackers and cookie banners",
    "On every site, from the moment you install it. See what was blocked on the page you are on.",
    ["Ads and tracking requests stopped before they load", "Cookie banners hidden; auto-reject optional",
     "Works on video sites too", "One switch per site"]) +
    '<div class="stage">' + popup("popup-light.png", 400) + '</div></div>' + NOTE)

page("shot-2-settings-1280x800.html", '<div class="wrap">' + text(
    "Every feature is a switch",
    "Turn ads, trackers, cookie banners and link-tracking clean-up on or off. Settings stay on your device.",
    ["No account, no sign-in", "Changes apply right away", "Built-in lists work offline"]) +
    '<div class="stage">' + crop("options-store-light.png", 174, 625, 0.88, bar="AdBrake settings") + '</div></div>' + NOTE)

page("shot-3-filters-1280x800.html", '<div class="wrap">' + text(
    "Hide anything, per site",
    "Click \u201cHide an element on this page\u201d, point at it, done. Turn blocking off for sites you trust.",
    ["Point and click to hide an element", "Allow a site with one switch", "Edit your own rules any time"]) +
    '<div class="stage"><div style="position:relative;width:640px;height:640px">'
    '<div style="position:absolute;right:0;top:20px">' + crop("options-store-light.png", 940, 1304, 0.86, bar="AdBrake settings") + '</div>'
    '<div style="position:absolute;left:0;bottom:0">' + popup("popup-light.png", 320) + '</div>'
    '</div></div></div>' + NOTE)

page("shot-4-privacy-1280x800.html", '<div class="wrap">' + text(
    "No telemetry. Open source.",
    "AdBrake sends nothing about you anywhere. The only downloads are the public filter lists, once a week.",
    ["MIT licence, code on GitHub", "No analytics, no remote config", "Free, with no paid tier"]) +
    '<div class="stage"><div style="position:relative;width:600px;height:640px">'
    '<div style="position:absolute;right:0;top:0">' + crop("options-dark.png", 2193, 2606, 0.78, bar="Filter lists") + '</div>'
    '<div style="position:absolute;left:0;bottom:0">' + popup("popup-dark.png", 330) + '</div>'
    '</div></div></div>' + NOTE, cls="dark")

page("shot-5-support-1280x800.html", '<div class="wrap">' + text(
    "Free for everyone",
    "Every feature is free, with no ads of its own and no upsell. If it saves you time, an optional tip helps keep it going.",
    ["Nothing is locked behind a payment", "Tips are optional", "Filter lists update by themselves"]) +
    '<div class="stage"><div style="position:relative;width:640px;height:600px">'
    '<div style="position:absolute;left:0;top:0">' + popup("popup-light.png", 330) + '</div>'
    '<div style="position:absolute;right:0;bottom:40px">' + crop("options-store-light.png", 2364, 2501, 0.9, bar="AdBrake settings") + '</div>'
    '</div></div></div>' + NOTE)

# 440x280 small promo tile
page("promo-small-440x280.html", '<div style="position:absolute;inset:0;background:linear-gradient(150deg,#2f7d5b,#1a4e37);'
     'display:flex;flex-direction:column;justify-content:center;padding:0 34px;color:#fff">'
     '<div style="display:flex;align-items:center;gap:16px"><div style="width:84px;height:84px;border-radius:22px;background:#fff;display:flex;align-items:center;justify-content:center;'
     'box-shadow:0 8px 20px rgba(0,0,0,.22)"><img src="icon128.png" style="width:64px;height:64px"></div><div style="font-size:44px;font-weight:800;'
     'letter-spacing:-.02em">AdBrake</div></div><div style="margin-top:18px;font-size:20px;line-height:1.35;'
     'color:#d9f0e4;font-weight:500">Blocks ads, trackers<br>and cookie banners.<br><span style=\'color:#fff;font-weight:700\'>Free. Open source. No telemetry.</span></div></div>')

# 1400x560 marquee
page("promo-marquee-1400x560.html", '<div style="position:absolute;inset:0;background:radial-gradient(900px 500px at 80% 30%,#3a8f69 0%,rgba(58,143,105,0) 65%),'
     'linear-gradient(150deg,#2f7d5b,#163f2d);color:#fff"></div><div class="wrap" style="padding:0 90px;gap:40px">'
     '<div style="flex:0 0 640px;color:#fff"><div style="display:flex;align-items:center;gap:18px"><div style="width:96px;height:96px;border-radius:26px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(0,0,0,.22)"><img src="icon128.png" style="width:74px;height:74px"></div>'
     '<div style="font-size:56px;font-weight:800;letter-spacing:-.02em">AdBrake</div></div>'
     '<div style="margin-top:26px;font-size:34px;font-weight:700;line-height:1.2">Blocks ads, trackers and cookie banners on every site.</div>'
     '<div style="margin-top:16px;font-size:22px;color:#cfeadc">Free. Open source. No telemetry.</div></div>'
     '<div class="stage" style="align-items:flex-start;padding-top:70px">' + popup("popup-light.png", 380) + '</div></div>')
