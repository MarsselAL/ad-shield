#!/usr/bin/env python3
"""Build every AdBrake icon from one master image.

The master is icons/source/adbrake-icon-master.png: the AdBrake app tile (light rounded square,
red shield, black/red "A") at full resolution with transparent corners. From it this script writes

  icons/icon16.png, icon32.png        the shield alone on transparent, cropped tight so it fills
                                      the toolbar slot (the tile's padding wastes too much at 16/32)
  icons/icon48.png, icon128.png       the whole tile
  docs/store/images/store-icon-{64,128,300}.png
                                      the whole tile with Chrome's store padding (1/8 per side)
  docs/store/images/src/icon128.png   the whole tile, for the store page mock-ups

Downscaling is Lanczos-3 on premultiplied alpha. It uses Pillow when installed and otherwise a
standard-library implementation (slower, about a minute, same result within rounding).

Run:  python3 -I tools/make_icons.py
      python3 -I tools/make_icons.py --from-source ART.webp   (re-make the master first: decode the
            artwork, find the rounded tile, make everything outside it transparent)
Decoding a .webp source needs Pillow with WebP support or macOS `sips`; the master PNG needs neither.
"""
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "icons", "source", "adbrake-icon-master.png")

# (path, size, mode). mode: "shield" = shield only, tight; "tile" = whole tile, small margin;
# "store" = whole tile with 1/8 padding per side (Chrome: 96x96 art in a 128x128 icon).
OUTPUTS = (
    ("icons/icon16.png", 16, "shield"),
    ("icons/icon32.png", 32, "shield"),
    ("icons/icon48.png", 48, "tile"),
    ("icons/icon128.png", 128, "tile"),
    ("docs/store/images/store-icon-64.png", 64, "store"),
    ("docs/store/images/store-icon-128.png", 128, "store"),
    ("docs/store/images/store-icon-300.png", 300, "store"),
    ("docs/store/images/src/icon128.png", 128, "tile"),
)
TILE_MARGIN = 0.02     # per side, as a share of the output size
SHIELD_MARGIN = 0.03
STORE_PAD = 0.125
RED_THRESHOLD = 110    # R - max(G, B) at the shield's outer edge (the pink glow stays below ~90)


# ---------------------------------------------------------------- PNG in/out (standard library)

def read_png(path):
    """Return (w, h, rgba bytearray) for an 8-bit, non-interlaced RGB or RGBA PNG."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG: %s" % path)
    pos, idat, w, h, ch = 8, [], 0, 0, 0
    while pos < len(data):
        ln, = struct.unpack(">I", data[pos:pos + 4])
        typ, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace or ctype not in (2, 6):
                raise ValueError("unsupported PNG (need 8-bit RGB/RGBA, not interlaced): %s" % path)
            ch = 3 if ctype == 2 else 4
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        ftype = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if ftype == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif ftype == 3:
            for x in range(stride):
                left = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255
        elif ftype == 4:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        prev = line
        if ch == 4:
            out[y * stride:(y + 1) * stride] = line
        else:
            o = y * w * 4
            out[o:o + w * 4] = bytes(b for x in range(w) for b in (line[3 * x], line[3 * x + 1], line[3 * x + 2], 255))
    return w, h, out


def write_png(path, w, h, rgba):
    def chunk(tag, payload):
        c = tag + payload
        return struct.pack(">I", len(payload)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    stride = w * 4
    rows = []
    prev = bytes(stride)
    for y in range(h):
        line = bytes(rgba[y * stride:(y + 1) * stride])
        up = bytes((line[x] - prev[x]) & 255 for x in range(stride))  # "up" filter: smaller files
        rows.append(b"\x02" + up)
        prev = line
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


# ---------------------------------------------------------------- master from the artwork

def decode_source(src):
    """Decode any image (e.g. .webp) to RGBA via Pillow, else macOS sips."""
    try:
        from PIL import Image  # noqa: WPS433 (optional)
        im = Image.open(src).convert("RGBA")
        return im.size[0], im.size[1], bytearray(im.tobytes())
    except ImportError:
        pass
    if not shutil.which("sips"):
        sys.exit("need Pillow (with WebP) or macOS sips to decode %s" % src)
    tmp = tempfile.mkdtemp()
    try:
        out = os.path.join(tmp, "src.png")
        subprocess.run(["sips", "-s", "format", "png", src, "--out", out], check=True, stdout=subprocess.DEVNULL)
        return read_png(out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _crossing(vals, thr):
    for k in range(1, len(vals)):
        if vals[k] >= thr > vals[k - 1]:
            return k - 1 + (thr - vals[k - 1]) / (vals[k] - vals[k - 1])
    return None


def _rr_sdf(x, y, cx, cy, hw, hh, r):
    qx, qy = abs(x - cx) - (hw - r), abs(y - cy) - (hh - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def make_master(src):
    """The artwork is the tile on black. Fit a rounded rectangle to the tile's edge, centre it,
    and make everything outside transparent with an anti-aliased edge."""
    w, h, px = decode_source(src)
    lum = [(px[i] + px[i + 1] + px[i + 2]) / 3 for i in range(0, len(px), 4)]
    thr = 110
    pts = []
    for y in range(0, h, 3):
        row = lum[y * w:(y + 1) * w]
        a, b = _crossing(row, thr), _crossing(row[::-1], thr)
        if a is not None:
            pts += [(a + 0.5, y + 0.5), (w - b - 0.5, y + 0.5)]
    for x in range(0, w, 3):
        col = lum[x::w]
        a, b = _crossing(col, thr), _crossing(col[::-1], thr)
        if a is not None:
            pts += [(x + 0.5, a + 0.5), (x + 0.5, h - b - 0.5)]
    if not pts:
        sys.exit("no tile found in %s" % src)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    cx0, cy0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    hw0, hh0 = (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2

    def rms(params):
        return math.sqrt(sum(_rr_sdf(x, y, *params) ** 2 for x, y in pts) / len(pts))

    best = None
    for r in range(int(min(hw0, hh0) * 0.1), int(min(hw0, hh0) * 0.8), 5):
        for dw in (-1, -0.5, 0, 0.5):
            for dh in (-1, -0.5, 0, 0.5):
                p = (cx0, cy0, hw0 + dw, hh0 + dh, r)
                e = rms(p)
                if best is None or e < best[0]:
                    best = (e, p)
    err, (cx, cy, hw, hh, r) = best
    print("tile: centre (%.1f, %.1f), %.1f x %.1f px, corner radius %d, fit error %.2f px rms"
          % (cx, cy, 2 * hw, 2 * hh, r, err))

    # Shift by whole pixels so the tile sits in the middle of the canvas (no resampling).
    sx, sy = int(round(w / 2 - cx)), int(round(h / 2 - cy))
    cx, cy = cx + sx, cy + sy
    out = bytearray(w * h * 4)
    band = 1.5   # source pixels this close to the edge are mixed with the black background

    def src_rgb(x, y):
        x, y = min(max(int(x) - sx, 0), w - 1), min(max(int(y) - sy, 0), h - 1)
        i = (y * w + x) * 4
        return px[i], px[i + 1], px[i + 2]

    for y in range(h):
        for x in range(w):
            fx, fy = x + 0.5, y + 0.5
            d = _rr_sdf(fx, fy, cx, cy, hw, hh, r)
            a = min(max(0.5 - d, 0.0), 1.0)
            if a <= 0:
                continue
            if d > -band:
                # take the colour from just inside the edge, along the outward normal
                qx, qy = abs(fx - cx) - (hw - r), abs(fy - cy) - (hh - r)
                if qx > 0 and qy > 0:
                    n = math.hypot(qx, qy)
                    nx, ny = qx / n, qy / n
                elif qx > qy:
                    nx, ny = 1.0, 0.0
                else:
                    nx, ny = 0.0, 1.0
                nx = nx if fx >= cx else -nx
                ny = ny if fy >= cy else -ny
                step = d + band + 1.0
                rgb = src_rgb(fx - nx * step, fy - ny * step)
            else:
                rgb = src_rgb(fx, fy)
            i = (y * w + x) * 4
            out[i:i + 4] = bytes((rgb[0], rgb[1], rgb[2], int(round(a * 255))))
    write_png(MASTER, w, h, out)
    print("wrote", os.path.relpath(MASTER, ROOT))


# ---------------------------------------------------------------- crops

def alpha_bbox(w, h, px, thr=8):
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        row = px[y * w * 4 + 3:(y + 1) * w * 4:4]
        hits = [x for x, a in enumerate(row) if a > thr]
        if hits:
            x0, x1 = min(x0, hits[0]), max(x1, hits[-1] + 1)
            y0, y1 = min(y0, y), max(y1, y + 1)
    return x0, y0, x1, y1


def shield_only(w, h, px):
    """Return a copy of the master with everything outside the red shield transparent, plus the
    shield's bounding box. The shield is one span per row and per column; a pixel's coverage is
    the smaller of its row and column coverage, which gives clean edges in every direction."""
    redness = [px[i] - max(px[i + 1], px[i + 2]) if px[i + 3] > 200 else -255 for i in range(0, len(px), 4)]
    rows, cols = {}, {}
    for y in range(h):
        line = redness[y * w:(y + 1) * w]
        a, b = _crossing(line, RED_THRESHOLD), _crossing(line[::-1], RED_THRESHOLD)
        if a is not None:
            rows[y] = (a, w - b)
    for x in range(w):
        col = redness[x::w]
        a, b = _crossing(col, RED_THRESHOLD), _crossing(col[::-1], RED_THRESHOLD)
        if a is not None:
            cols[x] = (a, h - b)
    if not rows:
        sys.exit("no red shield found in the master")

    def cover(lo, hi, p):
        return max(0.0, min(p + 1.0, hi) - max(p, lo))

    out = bytearray(len(px))
    for y, (rl, rr) in rows.items():
        for x in range(max(0, int(rl)), min(w, int(rr) + 1)):
            c = cols.get(x)
            if not c:
                continue
            a = min(cover(rl, rr, x), cover(c[0], c[1], y))
            if a > 0:
                i = (y * w + x) * 4
                out[i:i + 3] = px[i:i + 3]
                out[i + 3] = int(round(px[i + 3] * a))
    ys = sorted(rows)
    bbox = (int(min(v[0] for v in rows.values())), ys[0],
            int(math.ceil(max(v[1] for v in rows.values()))), ys[-1] + 1)
    return out, bbox


def square_box(box, margin, w, h):
    """Square box around `box`, grown so the content keeps `margin` (share of the side) per side."""
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0) / (1 - 2 * margin)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = int(math.ceil(side))
    bx, by = int(round(cx - side / 2)), int(round(cy - side / 2))
    return bx, by, side


def crop(w, h, px, bx, by, side):
    """Crop a side x side square at (bx, by); areas outside the image are transparent."""
    out = bytearray(side * side * 4)
    for y in range(side):
        sy = by + y
        if not 0 <= sy < h:
            continue
        x_lo, x_hi = max(0, -bx), min(side, w - bx)
        if x_lo < x_hi:
            s = (sy * w + bx + x_lo) * 4
            out[(y * side + x_lo) * 4:(y * side + x_hi) * 4] = px[s:s + (x_hi - x_lo) * 4]
    return out


# ---------------------------------------------------------------- resampling

def _lanczos(x, a=3):
    if x == 0:
        return 1.0
    if -a < x < a:
        px = math.pi * x
        return a * math.sin(px) * math.sin(px / a) / (px * px)
    return 0.0


def _weights(src_n, dst_n, kernel, support):
    scale = src_n / dst_n
    fscale = max(scale, 1.0)
    sup = support * fscale
    table = []
    for i in range(dst_n):
        centre = (i + 0.5) * scale
        lo, hi = max(0, int(centre - sup)), min(src_n, int(math.ceil(centre + sup)))
        ws = [kernel((j + 0.5 - centre) / fscale) for j in range(lo, hi)]
        total = sum(ws) or 1.0
        table.append((lo, [v / total for v in ws]))
    return table


def _box(x):
    return 1.0 if -0.5 <= x < 0.5 else 0.0


def _resample_planes(planes, sw, sh, dw, dh, kernel, support):
    """Separable resample of a list of float planes (row-major)."""
    import operator
    mul = operator.mul
    hw = _weights(sw, dw, kernel, support)
    vw = _weights(sh, dh, kernel, support)
    out = []
    for plane in planes:
        tmp = []
        for y in range(sh):
            base = y * sw
            tmp.extend(sum(map(mul, plane[base + lo:base + lo + len(ws)], ws)) for lo, ws in hw)
        cols = [tmp[x::dw] for x in range(dw)]
        res = [0.0] * (dw * dh)
        for x, col in enumerate(cols):
            for y, (lo, ws) in enumerate(vw):
                res[y * dw + x] = sum(map(mul, col[lo:lo + len(ws)], ws))
        out.append(res)
    return out


def resize(side, px, size):
    """Lanczos-3 resize of a side x side RGBA square to size x size (premultiplied alpha)."""
    try:
        from PIL import Image
        im = Image.frombytes("RGBA", (side, side), bytes(px))
        return bytearray(im.resize((size, size), Image.LANCZOS, reducing_gap=3.0).tobytes())
    except ImportError:
        pass
    a = [px[i + 3] / 255.0 for i in range(0, len(px), 4)]
    planes = [[px[i + c] * a[i // 4] for i in range(0, len(px), 4)] for c in range(3)] + [a]
    n = side
    # Box-reduce by a whole factor first (like Pillow's reducing_gap), then Lanczos the rest.
    f = n // (size * 3)
    if f >= 2:
        m = n // f
        planes = _resample_planes(planes, n, n, m, m, _box, 1.0)
        n = m
    planes = _resample_planes(planes, n, n, size, size, _lanczos, 3)
    out = bytearray(size * size * 4)
    for i in range(size * size):
        al = planes[3][i]
        if al <= 1e-4:
            continue
        for c in range(3):
            out[i * 4 + c] = min(255, max(0, int(round(planes[c][i] / al))))
        out[i * 4 + 3] = min(255, max(0, int(round(al * 255))))
    return out


# ---------------------------------------------------------------- main

def main(argv):
    if len(argv) >= 2 and argv[0] == "--from-source":
        make_master(argv[1])
    if not os.path.exists(MASTER):
        sys.exit("missing %s (make it with --from-source ART)" % MASTER)
    w, h, px = read_png(MASTER)
    tile_box = alpha_bbox(w, h, px)
    shield_px = None
    for rel, size, mode in OUTPUTS:
        if mode == "shield":
            if shield_px is None:
                shield_px, shield_box = shield_only(w, h, px)
            bx, by, side = square_box(shield_box, SHIELD_MARGIN, w, h)
            img = resize(side, crop(w, h, shield_px, bx, by, side), size)
        else:
            margin = STORE_PAD if mode == "store" else TILE_MARGIN
            bx, by, side = square_box(tile_box, margin, w, h)
            img = resize(side, crop(w, h, px, bx, by, side), size)
        write_png(os.path.join(ROOT, rel), size, size, img)
        print("wrote", rel)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
