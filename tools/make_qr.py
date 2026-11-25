#!/usr/bin/env python3
"""Make the static QR codes for "Support AdBrake" (standard library only, no network).

    python3 -I tools/make_qr.py           writes src/assets/qr/{revolut,usdc,btc}.svg
    python3 -I tools/make_qr.py --check   exits 1 when a committed SVG is not what the
                                          addresses in src/shared/donate.js give

Payloads, read from src/shared/donate.js (the same values as docs/donate.txt):
  revolut.svg  the tip link as it is
  usdc.svg     the USDC address as plain text (no "ethereum:" URI, so a wallet on another network
               does not treat it as a payment link)
  btc.svg      "bitcoin:<address>"

The encoder below is a small QR Code Model 2 implementation (byte mode, versions 1-10, error
correction level M, automatic mask choice), written for this project. Each SVG is dark modules
on a white rounded tile with a 4-module quiet zone, so it stays readable on a dark page.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DONATE_JS = os.path.join(ROOT, "src", "shared", "donate.js")
OUT = os.path.join(ROOT, "src", "assets", "qr")

# Error correction level M, versions 1-10: (ec codewords per block, [(blocks, data codewords)])
ECC_M = {
    1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]),
    5: (24, [(2, 43)]), 6: (16, [(4, 27)]), 7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]),
    9: (22, [(3, 36), (2, 37)]), 10: (26, [(4, 43), (1, 44)]),
}
ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
         8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}
ECL_M_BITS = 0  # format bits for level M


# ------------------------------------------------------------------ Reed-Solomon over GF(256)

def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z & 0xFF


def _rs_divisor(degree):
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 0x02)
    return result


def _rs_remainder(data, divisor):
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


# ------------------------------------------------------------------ encoding

def _codewords(payload):
    """Pick the smallest version that fits; return (version, final interleaved codewords)."""
    for version in range(1, 11):
        ec_len, groups = ECC_M[version]
        capacity = sum(n * d for n, d in groups)
        count_bits = 8 if version < 10 else 16
        if 4 + count_bits + 8 * len(payload) <= capacity * 8:
            break
    else:
        raise ValueError("payload too long for a version 1-10 QR code")
    bits = [0, 1, 0, 0]
    bits += [(len(payload) >> i) & 1 for i in range(count_bits - 1, -1, -1)]
    for b in payload:
        bits += [(b >> i) & 1 for i in range(7, -1, -1)]
    bits += [0] * min(4, capacity * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    data = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < capacity:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    blocks, pos = [], 0
    divisor = _rs_divisor(ec_len)
    for n, d in groups:
        for _ in range(n):
            blk = data[pos:pos + d]
            pos += d
            blocks.append((blk, _rs_remainder(blk, divisor)))
    out = []
    for i in range(max(len(b[0]) for b in blocks)):
        out += [b[0][i] for b in blocks if i < len(b[0])]
    for i in range(ec_len):
        out += [b[1][i] for b in blocks]
    return version, out


def _format_bits(mask):
    data = ECL_M_BITS << 3 | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return (data << 10 | rem) ^ 0x5412


def _version_bits(version):
    rem = version
    for _ in range(12):
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
    return version << 12 | rem


class _Matrix:
    def __init__(self, version):
        self.version = version
        self.size = size = version * 4 + 17
        self.dark = [[False] * size for _ in range(size)]
        self.func = [[False] * size for _ in range(size)]
        self._draw_function_patterns()

    def set(self, x, y, dark, func=True):
        self.dark[y][x] = bool(dark)
        if func:
            self.func[y][x] = True

    def _draw_function_patterns(self):
        size = self.size
        for i in range(size):
            self.set(6, i, i % 2 == 0)
            self.set(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < size and 0 <= y < size:
                        dist = max(abs(dx), abs(dy))
                        self.set(x, y, dist not in (2, 4))
        pos = ALIGN[self.version]
        last = len(pos) - 1
        for i, ay in enumerate(pos):
            for j, ax in enumerate(pos):
                if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format(0)  # reserve; redrawn with the real mask
        if self.version >= 7:
            bits = _version_bits(self.version)
            for i in range(18):
                bit = (bits >> i) & 1
                a, b = size - 11 + i % 3, i // 3
                self.set(a, b, bit)
                self.set(b, a, bit)

    def draw_format(self, mask):
        size = self.size
        bits = _format_bits(mask)
        bit = lambda i: (bits >> i) & 1  # noqa: E731
        for i in range(6):
            self.set(8, i, bit(i))
        self.set(8, 7, bit(6))
        self.set(8, 8, bit(7))
        self.set(7, 8, bit(8))
        for i in range(9, 15):
            self.set(14 - i, 8, bit(i))
        for i in range(8):
            self.set(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.set(8, size - 15 + i, bit(i))
        self.set(8, size - 8, True)

    def draw_codewords(self, data):
        size, i = self.size, 0
        right = size - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(size):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = size - 1 - vert if upward else vert
                    if not self.func[y][x] and i < len(data) * 8:
                        self.dark[y][x] = bool((data[i >> 3] >> (7 - (i & 7))) & 1)
                        i += 1
            right -= 2

    def apply_mask(self, mask):
        f = (lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
             lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
             lambda x, y: x * y % 2 + x * y % 3 == 0, lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
             lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0)[mask]
        for y in range(self.size):
            for x in range(self.size):
                if not self.func[y][x] and f(x, y):
                    self.dark[y][x] = not self.dark[y][x]

    def penalty(self):
        size, m, score = self.size, self.dark, 0
        lines = [row[:] for row in m] + [[m[y][x] for y in range(size)] for x in range(size)]
        finder = [True, False, True, True, True, False, True]
        for line in lines:
            run, prev = 0, None
            for v in line:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        score += run - 2
                    run, prev = 1, v
            if run >= 5:
                score += run - 2
            padded = [False] * 4 + line + [False] * 4
            for i in range(4, len(padded) - 10):
                if padded[i:i + 7] == finder and (not any(padded[i - 4:i]) or not any(padded[i + 7:i + 11])):
                    score += 40
        for y in range(size - 1):
            for x in range(size - 1):
                if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    score += 3
        dark = sum(sum(row) for row in m)
        score += 10 * (abs(dark * 20 - size * size * 10) // (size * size))
        return score


def encode(text):
    """Return the QR matrix (list of rows of bools) for a UTF-8 text."""
    version, data = _codewords(text.encode("utf-8"))
    best = None
    for mask in range(8):
        q = _Matrix(version)
        q.draw_codewords(data)
        q.apply_mask(mask)
        q.draw_format(mask)
        p = q.penalty()
        if best is None or p < best[0]:
            best = (p, q)
    return best[1].dark


def svg(text, label):
    m = encode(text)
    quiet = 4
    n = len(m) + 2 * quiet
    path = "".join("M%d %dh1v1h-1z" % (x + quiet, y + quiet)
                   for y, row in enumerate(m) for x, v in enumerate(row) if v)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges" '
            'role="img" aria-label="{label}">\n'
            '<rect width="{n}" height="{n}" rx="2" fill="#ffffff"/>\n'
            '<path fill="#000000" d="{path}"/>\n</svg>\n').format(n=n, label=label, path=path)


# ------------------------------------------------------------------ files

def donate_values(path=DONATE_JS):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    def val(key):
        m = re.search(r"\b%s:\s*'([^']*)'" % key, src)
        return m.group(1) if m else ""
    return {"url": val("url"), "usdc": val("usdcErc20"), "btc": val("btc")}


def wanted(values=None):
    """{file name: svg text} for every value that is set."""
    v = values or donate_values()
    out = {}
    if v["url"]:
        out["revolut.svg"] = svg(v["url"], "QR code for the AdBrake tip link")
    if v["usdc"]:
        out["usdc.svg"] = svg(v["usdc"], "QR code for the USDC address (Ethereum, ERC-20)")
    if v["btc"]:
        out["btc.svg"] = svg("bitcoin:" + v["btc"], "QR code for the Bitcoin address")
    return out


def main(argv):
    files = wanted()
    if "--check" in argv:
        bad = []
        for name, text in files.items():
            path = os.path.join(OUT, name)
            if not os.path.exists(path) or open(path, encoding="utf-8").read() != text:
                bad.append(name)
        if bad:
            print("stale QR codes (run tools/make_qr.py):", ", ".join(bad))
            return 1
        print("QR codes up to date")
        return 0
    os.makedirs(OUT, exist_ok=True)
    for name, text in files.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote", os.path.relpath(os.path.join(OUT, name), ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
