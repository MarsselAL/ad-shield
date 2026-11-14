#!/usr/bin/env python3
"""Write tests/fixtures/lists/golden.json: what the Python converter (tools/build_rules.py
convert_texts, using tools/filterlist.py) makes of the fixture lists in tests/fixtures/lists/.

tests/test_rules.py checks that the committed golden still equals the current Python output, and
tests/filterlist.test.js checks that the JavaScript port (src/shared/filterlist.js, used by the
extension's weekly list update) produces exactly the same. Run after a deliberate converter
change, in both converters:

    python3 -I tools/make_golden.py            rewrite the golden file
    python3 -I tools/make_golden.py DIR OUT    convert DIR/easylist.txt, ... and write OUT
                                               (used for the real-list comparison)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_rules  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "lists")
GOLDEN = os.path.join(FIXTURES, "golden.json")


def read_texts(lists_dir):
    texts = {}
    for key, name, _url, _prefix, _cat in build_rules.LISTS:
        with open(os.path.join(lists_dir, name), encoding="utf-8") as fh:
            texts[key] = fh.read()
    return texts


def golden(lists_dir=FIXTURES):
    """The comparable part of convert_texts(): per-list counts and rules, site data, generic."""
    conv = build_rules.convert_texts(read_texts(lists_dir))
    return {"lists": conv["lists"], "site": conv["site"], "generic": conv["generic"]}


def dumps(obj):
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv):
    if len(argv) == 3:
        src, out = argv[1], argv[2]
    elif len(argv) == 1:
        src, out = FIXTURES, GOLDEN
    else:
        print(__doc__)
        return 2
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(dumps(golden(src)))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
