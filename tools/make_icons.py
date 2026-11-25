#!/usr/bin/env python3
"""Generate the extension icons (16/32/48/128 px PNG) with the standard library only.

AdBrake: a rounded square with a diagonal orange-to-red gradient and a white "brake" mark,
a thick ring (brake disc) with a short horizontal bar across the centre. No text, no
third-party branding. The 16 px version uses thicker strokes so it still reads.

Run:  python3 -I tools/make_icons.py            (writes icons/icon{16,32,48,128}.png)
      python3 -I tools/make_icons.py --store    (also writes the store icons in
                                                 docs/store/images/: store-icon-{64,128,300}.png
                                                 and src/icon128.png)
"""
import math
import os
import shutil
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
STORE = os.path.join(ROOT, "docs", "store", "images")
SIZES = (16, 32, 48, 128)
STORE_SIZES = (64, 128, 300)
SS = 4  # supersampling per axis

GRAD_START = (0xFF, 0x8A, 0x00)  # top-left, orange
GRAD_END = (0xE5, 0x24, 0x2B)    # bottom-right, red
MARK = (255, 255, 255)


def geometry(size):
    """Shape parameters in unit coordinates (0..1). Small sizes get a bolder, simpler mark."""
    if size <= 16:
        return {"inset": 0.0, "corner": 0.20, "ring_r": 0.38, "ring_w": 0.15,
                "bar_half": 0.14, "bar_h": 0.15}
    if size <= 32:
        return {"inset": 0.02, "corner": 0.21, "ring_r": 0.35, "ring_w": 0.12,
                "bar_half": 0.15, "bar_h": 0.12}
    return {"inset": 0.04, "corner": 0.22, "ring_r": 0.33, "ring_w": 0.10,
            "bar_half": 0.16, "bar_h": 0.10}


def inside_rounded_square(u, v, inset, corner):
    lo, hi = inset, 1.0 - inset
    if u < lo or u > hi or v < lo or v > hi:
        return False
    cx = min(max(u, lo + corner), hi - corner)
    cy = min(max(v, lo + corner), hi - corner)
    return math.hypot(u - cx, v - cy) <= corner


def on_mark(u, v, g):
    d = math.hypot(u - 0.5, v - 0.5)
    if g["ring_r"] - g["ring_w"] <= d <= g["ring_r"]:
        return True
    return abs(u - 0.5) <= g["bar_half"] and abs(v - 0.5) <= g["bar_h"] / 2


def gradient(u, v):
    t = min(1.0, max(0.0, (u + v) / 2.0))
    return tuple(a + (b - a) * t for a, b in zip(GRAD_START, GRAD_END))


def render(size):
    g = geometry(size)
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    if not inside_rounded_square(u, v, g["inset"], g["corner"]):
                        continue
                    col = MARK if on_mark(u, v, g) else gradient(u, v)
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 1
            n = SS * SS
            a = acc[3] / n
            if acc[3]:
                r, gg, b = (int(round(c / acc[3])) for c in acc[:3])
            else:
                r = gg = b = 0
            row += bytes((r, gg, b, int(round(a * 255))))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + r for r in rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def write(path, size):
    with open(path, "wb") as f:
        f.write(png(size, render(size)))
    print("wrote", os.path.relpath(path, ROOT))


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        write(os.path.join(OUT, "icon%d.png" % s), s)
    if "--store" in argv:
        for s in STORE_SIZES:
            write(os.path.join(STORE, "store-icon-%d.png" % s), s)
        dst = os.path.join(STORE, "src", "icon128.png")
        shutil.copyfile(os.path.join(OUT, "icon128.png"), dst)
        print("wrote", os.path.relpath(dst, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
