#!/usr/bin/env python3
"""Write docs/store/privacy-policy.html from docs/store/privacy-policy.md (standard library only).

    python3 -I tools/privacy_html.py

Served by GitHub Pages (Settings > Pages > branch main, folder /docs) at
https://marsselal.github.io/ad-shield/store/privacy-policy.html
Converts only the Markdown this file uses (headings, paragraphs, flat lists, **bold**, _italic_,
`code`, bare https links) and stops at the first "---" line (the hosting notes for Marsel).
"""
import html
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "store", "privacy-policy.md")
OUT = os.path.join(ROOT, "docs", "store", "privacy-policy.html")
STYLE = ("body{font:16px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:720px;margin:2rem auto;"
         "padding:0 1rem;color:#1a1a1a;background:#fff}"
         "@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}a{color:#8ab4f8}}"
         "code{background:rgba(127,127,127,.18);padding:0 .25em;border-radius:3px;overflow-wrap:anywhere}"
         "h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:1.8rem}li{margin:.25rem 0}"
         ".brand{display:flex;align-items:center;gap:.6rem}.brand svg{flex:none}")
SHIELD = ('<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11'
          '-4.6-1.7-8-6-8-11V5z" fill="#2f7d5b"/><path d="M7.5 12.2l3 3 6-6.4" fill="none" stroke="#fff" '
          'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>')


def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<![\w/])_(.+?)_(?!\w)", r"<em>\1</em>", t)
    t = re.sub(r"(?<![\">])(https://[^\s<)]+?)([.,;]?)(?=\s|$|<)", r'<a href="\1">\1</a>\2', t)
    return t


def convert(md):
    """Headings, paragraphs and flat lists ("- " or "1. ", continuation lines indented)."""
    out, para, items, kind = [], [], [], None

    def flush():
        nonlocal para, items, kind
        if para:
            out.append("<p>%s</p>" % inline(" ".join(para)))
        if items:
            out.append("<%s>%s</%s>" % (kind, "".join("<li>%s</li>" % inline(i) for i in items), kind))
        para, items, kind = [], [], None

    for raw in md.split("\n"):
        line = raw.rstrip()
        if line.strip() == "---":
            break
        m_h = re.match(r"^(#{1,3}) (.*)", line)
        m_li = re.match(r"^(- |\d+\. )(.*)", line)
        if m_h:
            flush()
            lvl, text = len(m_h.group(1)), inline(m_h.group(2))
            out.append('<h1 class="brand">%s%s</h1>' % (SHIELD, text) if lvl == 1 else "<h%d>%s</h%d>" % (lvl, text, lvl))
        elif m_li:
            k = "ul" if m_li.group(1) == "- " else "ol"
            if para or (kind and kind != k):
                flush()
            kind = k
            items.append(m_li.group(2))
        elif not line.strip():
            flush()
        elif items and raw.startswith(" "):
            items[-1] += " " + line.strip()
        else:
            if items:
                flush()
            para.append(line.strip())
    flush()
    return "\n".join(out)


def build():
    with open(SRC, encoding="utf-8") as fh:
        body = convert(fh.read())
    return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
            '<title>AdBrake — Privacy Policy</title>\n<style>%s</style></head>\n<body>\n%s\n</body></html>\n'
            % (STYLE, body))


def main():
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(build())
    print("wrote", os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
