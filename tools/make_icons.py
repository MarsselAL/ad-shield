#!/usr/bin/env python3
"""Generate the extension icons (16/32/48/128 px PNG) with the standard library only.

A green shield with a white check mark. No third-party branding.
Run:  python3 -I tools/make_icons.py      (writes icons/icon{16,32,48,128}.png)
"""
import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling per axis

SHIELD = (47, 125, 91)       # #2f7d5b
SHIELD_EDGE = (31, 88, 63)
CHECK = (255, 255, 255)


def shield_half_width(v):
    """Half-width of the shield (in unit coords) at height v (0 = top, 1 = bottom)."""
    top, shoulder, tip = 0.07, 0.50, 0.95
    if v < top or v > tip:
        return -1.0
    if v <= shoulder:
        # slight inward curve at the very top corners
        return 0.39 - 0.03 * (1 - min(1.0, (v - top) / 0.08))
    t = (v - shoulder) / (tip - shoulder)
    return 0.39 * (1 - t ** 1.7)


def inside_shield(u, v, inset=0.0):
    hw = shield_half_width(v)
    if hw < 0:
        return False
    if inset and (v < 0.07 + inset or v > 0.95 - inset * 2.2):
        return False
    return abs(u - 0.5) <= hw - inset


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def on_check(u, v, width):
    pts = [(0.31, 0.50), (0.45, 0.65), (0.70, 0.35)]
    d = min(seg_dist(u, v, *pts[0], *pts[1]), seg_dist(u, v, *pts[1], *pts[2]))
    return d <= width / 2


def render(size):
    rows = []
    check_w = 0.13 if size <= 16 else 0.10
    edge = 0.0 if size <= 16 else 0.035
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    if not inside_shield(u, v):
                        continue
                    if on_check(u, v, check_w):
                        col = CHECK
                    elif edge and not inside_shield(u, v, edge):
                        col = SHIELD_EDGE
                    else:
                        col = SHIELD
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 1
            n = SS * SS
            a = acc[3] / n
            if acc[3]:
                r, g, b = (int(round(c / acc[3])) for c in acc[:3])
            else:
                r = g = b = 0
            row += bytes((r, g, b, int(round(a * 255))))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + r for r in rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, "icon%d.png" % s)
        with open(path, "wb") as f:
            f.write(png(s, render(s)))
        print("wrote", os.path.relpath(path, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
