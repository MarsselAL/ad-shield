#!/bin/bash
# Rebuilds the content-script bundles (tools/build.py), runs every tests/*.test.js with macOS
# JavaScriptCore (offline, synthetic fixtures only; tests/bundle.test.js loads the bundles),
# then runs tests/test_rules.py (filter converter + every generated DNR rule against the schema),
# tests/test_package.py (the shareable zip: INSTALL.txt in, development files out), tests/test_qr.py
# (the support QR codes match src/shared/donate.js), tests/test_popup_layout.py (the popup rendered
# in headless Chrome: nothing scrolls or is cut off, every support view reachable; skipped without
# Google Chrome) and
# validates manifest.json and the DNR rulesets. Exits non-zero on any failure.
set -u
cd "$(dirname "$0")/.." || exit 2
JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc}"
if [ ! -x "$JSC" ]; then echo "jsc not found at $JSC"; exit 2; fi

echo "== tools/build.py"
python3 -I tools/build.py || { echo "TESTS FAILED (bundle build)"; exit 1; }

fail=0; files=0; total=0
for t in tests/*.test.js; do
  files=$((files + 1))
  echo "== $t"
  out="$("$JSC" tests/lib/harness.js "$t" tests/lib/finish.js 2>&1)"; code=$?
  echo "$out"
  if [ $code -ne 0 ] || ! printf '%s\n' "$out" | grep -q '^RESULT OK'; then
    fail=1; echo "!! $t failed (exit $code)"
  else
    n=$(printf '%s\n' "$out" | sed -n 's/^RESULT OK \([0-9]*\) passed$/\1/p'); total=$((total + n))
  fi
done

for py in tests/test_rules.py tests/test_package.py tests/test_qr.py tests/test_popup_layout.py; do
  echo "== $py"
  files=$((files + 1))
  out="$(python3 -I "$py" 2>&1)"; code=$?
  printf '%s\n' "$out" | tail -n 3
  if [ $code -ne 0 ] || ! printf '%s\n' "$out" | grep -q '^RESULT OK'; then
    printf '%s\n' "$out"; fail=1; echo "!! $py failed (exit $code)"
  else
    n=$(printf '%s\n' "$out" | sed -n 's/^RESULT OK \([0-9]*\) passed$/\1/p'); total=$((total + n))
  fi
done

echo "== tests/validate_manifest.py"
python3 -I tests/validate_manifest.py || fail=1

if [ $fail -ne 0 ]; then echo "TESTS FAILED"; exit 1; fi
echo "ALL TESTS PASSED ($total tests in $files files)"
