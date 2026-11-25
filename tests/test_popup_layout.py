#!/usr/bin/env python3
"""Layout test for the popup (src/popup/): renders popup.html in headless Google Chrome with
stand-ins for chrome.* (no extension, no network), at the size Chrome gives a popup (the page's
preferred size, at most 800x600), on a normal web tab and on a Twitch tab (the extra Twitch row),
in light and dark, and with the occasional support note shown. For each it checks:

  - nothing scrolls: scrollHeight <= clientHeight (and widths) on html, body and both panels;
  - no visible element's box leaves its panel (screen-reader-only text aside), and no panel
    leaves the popup;
  - the support panel's Phone, USDC and BTC tabs are on screen and clickable (elementFromPoint),
    and each one shows its view (QR code; address and Copy for the coins) fully inside the popup.

The last point is what failed on Twitch in 2.0.3: the Twitch section made the grid row taller than
the popup, the support panel stretched with it, and its crypto section ended up below the bottom
edge of the popup (cut off), with an empty gap in the middle of the panel.

Run with:  python3 -I tests/test_popup_layout.py   (prints "RESULT OK <n> passed"; needs Google
Chrome; without it the test says SKIPPED and passes 0 tests). ADBRAKE_ROOT=<dir> checks another
copy of the extension (for example an older commit) instead of this one.
"""
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("ADBRAKE_ROOT") or os.path.dirname(HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
import live_test as lt  # noqa: E402

# chrome.* stand-ins. ?twitch=1: the current tab is a Twitch channel with the page script loaded;
# ?highlight=1: the occasional support note is due. Counts are made up; no address or link here
# (src/shared/donate.js supplies them).
STUB = r"""
(function () {
  var q = new URLSearchParams(location.search);
  var twitch = q.has('twitch'), highlight = q.has('highlight');
  var DAY = 86400000;
  var store = {
    adbrakeInstalledAt: Date.now() - 40 * DAY,
    adbrakeSeenBlocked: { total: highlight ? 9990 : 120, lastKey: 'x', lastCount: 0 },
    adbrakeSupportPrompt: { version: '2.0.3', lastMilestone: highlight ? 1000 : 0, lastShownAt: highlight ? Date.now() - 90 * DAY : 0 }
  };
  var tw = { detected: 3, backup: 2, stripped: 1, standalone: 0, failures: 0 };
  var twState = { tab: { stats: tw, degraded: false, lastEvent: { at: Date.now() - 60000, text: 'Ad blocked' } },
    lifetime: { detected: 412, backup: 380, stripped: 30, standalone: 9, failures: 2 } };
  function infos() {
    var out = [], add = function (set, n) { for (var i = 0; i < n; i++) out.push({ rule: { ruleId: 100 + out.length, rulesetId: set } }); };
    add('ads_1', 31); add('privacy_1', 17); add('cookie_strip', 6); add('cookies_1', 1);
    return out;
  }
  var noop = function () {};
  window.chrome = {
    runtime: { getManifest: function () { return { version: '2.0.3' }; }, openOptionsPage: noop, lastError: undefined,
      sendMessage: function (m) { return Promise.resolve(m && m.type === 'popup-get-state' && twitch ? twState : null); },
      getURL: function (p) { return p; }, onMessage: { addListener: noop } },
    tabs: { query: function () { return Promise.resolve([{ id: 7, url: twitch ? 'https://www.twitch.tv/somechannel' : 'https://news.example.com/world/today' }]); },
      create: function () { return Promise.resolve({}); }, reload: noop,
      sendMessage: function (a, b, c, cb) { cb && cb(twitch ? { pageHooked: true, degraded: [] } : null); } },
    storage: {
      local: { get: function (k) { var o = {}; [].concat(k).forEach(function (x) { if (x in store) o[x] = store[x]; }); return Promise.resolve(o); },
        set: function (o) { Object.assign(store, o); return Promise.resolve(); } },
      session: { get: function () { return Promise.resolve({ 'page:7': { t: 1, hidden: 2, rejected: 0 } }); } },
      onChanged: { addListener: noop }
    },
    declarativeNetRequest: { getMatchedRules: function () { return Promise.resolve({ rulesMatchedInfo: infos() }); } },
    scripting: { executeScript: function () { return Promise.resolve(); } }
  };
})();
"""

# The popup's preferred size, as Chrome sizes a popup to its document (capped at 800x600): measured
# in a very short viewport so that 100vh (body min-height in src/ui/common.css) adds nothing.
SIZE_JS = """(() => { const r = document.body.getBoundingClientRect();
  return [Math.min(800, Math.ceil(r.right)), Math.min(600, Math.ceil(document.documentElement.scrollHeight))]; })()"""

CHECK_JS = r"""(() => {
  const problems = [];
  const vis = e => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.getClientRects().length > 0; };
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : '');
  const scroll = e => { if (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)
    problems.push(name(e) + ' scrolls: ' + e.scrollWidth + 'x' + e.scrollHeight + ' in ' + e.clientWidth + 'x' + e.clientHeight); };
  scroll(document.documentElement); scroll(document.body);
  for (const p of document.querySelectorAll('.panel')) {
    if (!vis(p)) continue;
    scroll(p);
    const pr = p.getBoundingClientRect();
    if (pr.left < -0.5 || pr.top < -0.5 || pr.right > innerWidth + 0.5 || pr.bottom > innerHeight + 0.5)
      problems.push(name(p) + ' leaves the popup: ' + [pr.left, pr.top, pr.right, pr.bottom].map(Math.round) + ' vs ' + innerWidth + 'x' + innerHeight);
    for (const e of p.querySelectorAll('*')) {
      if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
      if (e.closest('.sr-only')) continue;   // clipped to 1px on purpose (screen readers only)
      if (!vis(e)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < pr.left - 0.5 || r.top < pr.top - 0.5 || r.right > pr.right + 0.5 || r.bottom > pr.bottom + 0.5)
        problems.push(name(e) + ' leaves ' + name(p) + ': ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
    }
  }
  return problems;
})()"""

# Is the element on screen, inside the popup, and the topmost thing at its centre?
REACH_JS = r"""((id) => {
  const e = document.getElementById(id);
  if (!e) return id + ' missing';
  const s = getComputedStyle(e);
  if (s.display === 'none' || s.visibility === 'hidden' || !e.getClientRects().length) return id + ' not rendered';
  const r = e.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return id + ' too small: ' + r.width + 'x' + r.height;
  if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5)
    return id + ' outside the popup: ' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ' vs ' + innerWidth + 'x' + innerHeight;
  let op = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
  if (op < 0.99) return id + ' faded out (opacity ' + op + ')';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || !(hit === e || e.contains(hit) || hit.contains(e))) return id + ' covered by ' + (hit ? hit.outerHTML.slice(0, 80) : 'nothing');
  return '';
})"""

VIEWS = (("phone", "support-phone", ("support-phone",)),
         ("usdc", "coin-usdc", ("usdc-address", "usdc-copy")),
         ("btc", "coin-btc", ("btc-address", "btc-copy")))


def harness_url(tmp):
    src_dir = os.path.join(ROOT, "src", "popup")
    with open(os.path.join(src_dir, "popup.html"), encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace("<head>", '<head>\n<base href="file://%s/">\n<script>%s</script>' % (src_dir, STUB), 1)
    path = os.path.join(tmp, "popup.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    return "file://" + path


@unittest.skipUnless(os.path.exists(lt.CHROME), "Google Chrome not found at " + lt.CHROME)
class PopupLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="adbrake-popup-layout-")
        cls.url = harness_url(cls.tmp)
        cls.cdp = lt.PipeCDP(["--window-size=1000,800", "--hide-scrollbars", "--allow-file-access-from-files"], headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.cdp.close()

    def open(self, query, dark):
        cdp = self.cdp
        tid, sid = lt.open_page(cdp, self.url + query)
        self.addCleanup(lambda: cdp.send("Target.closeTarget", {"targetId": tid}))
        cdp.send("Emulation.setDeviceMetricsOverride", {"width": 800, "height": 40, "deviceScaleFactor": 1, "mobile": False}, session=sid)
        cdp.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark" if dark else "light"},
                                                             {"name": "prefers-reduced-motion", "value": "reduce"}]}, session=sid)
        cdp.send("Page.reload", session=sid)
        deadline = time.time() + 10
        while time.time() < deadline:   # popup.js has run and the counts are in
            time.sleep(0.2)
            try:
                if cdp.evaluate(sid, "document.readyState === 'complete' && document.getElementById('g-ads').textContent !== '–'"):
                    break
            except lt.CDPError:
                pass
        time.sleep(0.3)
        w, h = cdp.evaluate(sid, SIZE_JS)
        cdp.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, session=sid)
        time.sleep(0.3)
        return sid, w, h

    def check_state(self, query, dark, twitch):
        sid, w, h = self.open(query, dark)
        label = "%s %s (%dx%d)" % (query or "normal tab", "dark" if dark else "light", w, h)
        ev = lambda js: self.cdp.evaluate(sid, js)  # noqa: E731
        with self.subTest(label, check="twitch row"):
            self.assertEqual(ev("!document.getElementById('twitch').hidden"), twitch, label + ": Twitch row shown only on Twitch")
        with self.subTest(label, check="size"):
            self.assertLessEqual(w, 800, label)
            self.assertLessEqual(h, 600, label)
        with self.subTest(label, check="no scroll or clipping"):
            self.assertEqual(ev(CHECK_JS), [], label)
        for key, view, parts in VIEWS:
            with self.subTest(label, view=key):
                tab = "tab-" + key
                self.assertEqual(ev(REACH_JS + "(%r)" % tab), "", label + ": " + tab + " reachable")
                ev("document.getElementById(%r).click()" % tab)
                time.sleep(0.3)
                self.assertEqual(ev("document.getElementById(%r).getAttribute('aria-selected')" % tab), "true", label)
                for part in (view,) + parts:
                    self.assertEqual(ev(REACH_JS + "(%r)" % part), "", label + ": " + key + " view")
                qr = ev("(() => { const i = document.querySelector('#%s img'); if (!i) return 'no QR image';"
                        " const r = i.getBoundingClientRect(); return r.width >= 80 && r.bottom <= innerHeight && i.complete && i.naturalWidth > 0 ? '' :"
                        " 'QR not shown: ' + [r.width, r.bottom, i.complete, i.naturalWidth]; })()" % view)
                self.assertEqual(qr, "", label + ": " + key + " QR code")
                self.assertEqual(ev(CHECK_JS), [], label + " with " + key + " selected")
        return w, h

    def test_normal_tab_light_and_dark(self):
        for dark in (False, True):
            self.check_state("", dark, twitch=False)

    def test_twitch_tab_light_and_dark(self):
        # 2.0.3: the crypto section was pushed below the popup's bottom edge on Twitch tabs.
        for dark in (False, True):
            self.check_state("?twitch=1", dark, twitch=True)

    def test_support_note_shown(self):
        self.check_state("?highlight=1", False, twitch=False)


if __name__ == "__main__":
    if not os.path.exists(lt.CHROME):
        print("SKIPPED: Google Chrome not found at " + lt.CHROME)
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    if result.wasSuccessful():
        print("RESULT OK %d passed" % (result.testsRun - len(result.skipped)))
        sys.exit(0)
    print("RESULT FAILED")
    sys.exit(1)
