#!/usr/bin/env python3
"""Twitch Ad Shield - browser test harness (Python 3.9, standard library only).

Launches Google Chrome with a fresh temporary profile and talks to it over the Chrome DevTools
Protocol on a pipe (--remote-debugging-pipe: Chrome reads commands on fd 3 and writes replies
on fd 4, NUL-delimited JSON). The unpacked extension is loaded with CDP
Extensions.loadUnpacked, because branded Chrome 137+ ignores --load-extension
(needs --enable-unsafe-extension-debugging).

Modes
  --smoke
      No Twitch traffic. Loads the extension, checks the service worker (only the general
      as-* content scripts registered, manifest Twitch content scripts present, enabled DNR
      rulesets, testMatchOutcome for an ad / tracker / tracking-cookie request, on/off switch), opens the popup and options pages via chrome-extension:// URLs, runs the
      MAIN-world code on about:blank, collects console errors and exceptions, prints PASS/FAIL.
  --live CHANNEL [--minutes N] [--vod URL] [--switch-to CHANNEL2] [--compare-without-extension]
      Opens https://www.twitch.tv/CHANNEL in a 1920x1080 window, rejects the cookie banner
      (never accepts), clicks through the mature-content gate, makes sure the video plays
      (muted: --mute-audio), and records:
        - usher / m3u8 / gql / edge.ads requests from the page AND from Twitch's video Web
          Worker (CDP auto-attach), query strings redacted;
        - for every media playlist: the number of ad marker lines (markers read from
          src/config.js) - "Twitch served an ad to the worker"; bodies are not stored;
        - the playerType values in GQL PlaybackAccessToken requests;
        - the main player's video state every 2 s (did it advance?), Twitch's visible ad UI,
          the extension's "Ad blocked" toast, chat lines, channel points, navigation;
        - [TAS] console lines, console errors split into extension vs Twitch;
        - a screenshot every 30 s, Performance.getMetrics every 10 s, Chrome CPU/RSS via ps.
      Phases: watch N minutes, quality switch (localStorage + reload), refresh, channel switch
      (if --switch-to, in-app navigation), VOD (if --vod).
      --compare-without-extension runs the same scenario a second time without the
      extension as a baseline.
      THIS MAKES REQUESTS TO TWITCH. Run it only with the owner's approval.

Results: results/<timestamp>/report.json and report.md (+ screenshots for --live).
"""
import argparse
import base64
import datetime
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

# =========================================================================== TWITCH-SPECIFIC
# Everything this harness assumes about Twitch's page markup lives in this block. It is a test
# tool, so these are NOT used by the extension. Update here when Twitch changes. Checked 2026-11-12.
TWITCH = {
    # Main player container (the <video> inside it is the one we measure).
    "player": ['[data-a-target="video-player"]', '.video-player', '[data-a-target="player-overlay-click-handler"]'],
    # Twitch's own ad UI shown while an ad plays.
    "ad_ui": ['[data-a-target="video-ad-label"]', '[data-a-target="video-ad-countdown"]',
              '[data-test-selector="ad-banner-default-text"]', '[data-a-target="video-ad-overlay"]'],
    # Short leaf texts inside the player that mean "an ad is on screen" (case-insensitive, whole text).
    "ad_text_re": r"^(ad|ads|ad \d+ of \d+|ad \d+\s*/\s*\d+|ad \(\d+:\d+\)|commercial break.*|werbung.*|anzeige.*)$",
    # The extension's toast (src/content/bridge.js: role=status, text from src/shared/stats.js).
    "toast": '[role="status"]',
    "toast_re": r"ad blocked|ad shield",
    # Chat lines (Twitch native + 7TV) and "chat exists" markers.
    "chat_line": '[data-a-target="chat-line-message"], .chat-line__message, .seventv-message',
    "chat_present": '[data-a-target="chat-input"], .chat-scrollable-area__message-container, '
                    '[data-test-selector="chat-scrollable-area__message-container"], .chat-room',
    # Channel points (only rendered for logged-in viewers).
    "points": '[data-test-selector="community-points-summary"]',
    # Present only when logged out.
    "logged_out": '[data-a-target="login-button"], [data-a-target="signup-button"]',
    # Cookie banner: a button whose whole text matches consent_reject_re, inside an ancestor whose
    # text / attributes match consent_context_re. We only ever click REJECT-type buttons.
    "consent_reject_re": r"^(reject|reject all|reject all cookies|reject non-essential( cookies)?|decline|decline all|"
                         r"refuse|refuse all|only necessary|necessary only|use necessary cookies only|"
                         r"ablehnen|alle ablehnen|nur notwendige.*|refuser.*|tout refuser|rechazar.*|rifiuta.*)$",
    "consent_context_re": r"cookie|consent|advertising choices|datenschutz",
    # Mature-content / content-classification gate.
    "mature_buttons": ['[data-a-target="content-classification-gate-overlay-start-watching-button"]',
                       '[data-a-target="player-overlay-mature-accept"]'],
    "mature_text_re": r"^(start watching|weiter zum stream|weiterschauen)$",
}
# =========================================================================== end Twitch-specific

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SW_PATH = "src/background/service-worker.js"
CONFIG_JS = os.path.join(ROOT, "src", "config.js")
INTERESTING = re.compile(r"usher\.ttvnw\.net|\.m3u8|gql\.twitch\.tv|edge\.ads\.twitch\.tv|amazon-adsystem|media-amazon\.com")
REDACT_QUERY = re.compile(r"\?.*$")
VIEWPORT = (1920, 1080)

# Chrome flags that keep a throwaway profile quiet (no sync, no component updates, no pings).
QUIET_FLAGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    "--no-pings",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
]

# Extra flags for --live: desktop-size window, English UI (consent texts), muted autoplay,
# no throttling when the window is behind other windows.
LIVE_FLAGS = [
    "--window-size=%d,%d" % VIEWPORT,
    "--window-position=0,0",
    "--accept-lang=en-US,en",
    "--lang=en-US",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
]

# CDP settings for auto-attached workers / iframes.
AUTO_ATTACH = {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}
NET_ENABLE = {"maxTotalBufferSize": 50000000, "maxResourceBufferSize": 5000000}


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def redact(url):
    """Drop query strings (usher/gql URLs carry tokens and signatures) and shorten long
    token-like path segments (weaver playlist paths embed encoded tokens)."""
    url = REDACT_QUERY.sub("?…", url or "")
    m = re.match(r"^([a-z-]+://[^/]+)(/.*)?$", url)
    if not m or not m.group(2):
        return url
    segs = [(s[:12] + "…" + s[-8:]) if len(s) > 40 else s for s in m.group(2).split("/")]
    return m.group(1) + "/".join(segs)


# --------------------------------------------------------------------------- CDP over a pipe
class CDPError(Exception):
    pass


class PipeCDP:
    """Minimal CDP client over --remote-debugging-pipe (fd 3 = commands in, fd 4 = replies out).

    With auto_attach=True every Target.attachedToTarget (workers, iframes of a session on which
    Target.setAutoAttach was called) is handled on a helper thread: Runtime/Log/Network are
    enabled on the new session, auto-attach is set recursively, then
    Runtime.runIfWaitingForDebugger releases the paused target. Those commands are
    fire-and-forget so the worker is not held up by the main thread."""

    def __init__(self, extra_args, headless, auto_attach=False):
        self.profile = tempfile.mkdtemp(prefix="tas-chrome-")
        cmd_r, self._cmd_w = os.pipe()     # we write, Chrome reads on fd 3
        self._resp_r, resp_w = os.pipe()   # Chrome writes on fd 4, we read
        args = [CHROME, "--user-data-dir=" + self.profile, "--remote-debugging-pipe",
                "--enable-unsafe-extension-debugging"] + QUIET_FLAGS + list(extra_args)
        if headless:
            args.append("--headless=new")
        args.append("about:blank")

        def child_fds():
            os.dup2(cmd_r, 3)
            os.dup2(resp_w, 4)

        self.proc = subprocess.Popen(args, pass_fds=(3, 4), preexec_fn=child_fds,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     start_new_session=True)
        os.close(cmd_r)
        os.close(resp_w)
        self._next = 0
        self._lock = threading.Lock()
        self._wlock = threading.Lock()
        self._waiters = {}
        self.events = queue.Queue()
        self.stderr_tail = []
        self.auto_attach = auto_attach
        self.child_sessions = {}   # sessionId -> {type, url, parent, attached, detached}
        self._attach_q = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        threading.Thread(target=self._stderr_loop, daemon=True).start()
        if auto_attach:
            threading.Thread(target=self._attach_loop, daemon=True).start()

    def _stderr_loop(self):
        for line in iter(self.proc.stderr.readline, b""):
            self.stderr_tail.append(line.decode("utf-8", "replace").rstrip())
            del self.stderr_tail[:-50]

    def _read_loop(self):
        buf = b""
        while True:
            try:
                chunk = os.read(self._resp_r, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except ValueError:
                    continue
                if "id" in msg:
                    with self._lock:
                        w = self._waiters.pop(msg["id"], None)
                    if w is not None:
                        w.put(msg)
                else:
                    msg["_t"] = time.time()
                    method = msg.get("method")
                    if self.auto_attach and method == "Target.attachedToTarget":
                        self._attach_q.put(msg)
                    elif method == "Target.detachedFromTarget":
                        info = self.child_sessions.get(msg.get("params", {}).get("sessionId"))
                        if info is not None:
                            info["detached"] = msg["_t"]
                    self.events.put(msg)
        self.events.put({"method": "_closed"})
        self._attach_q.put(None)

    def _attach_loop(self):
        while True:
            msg = self._attach_q.get()
            if msg is None:
                return
            p = msg.get("params", {})
            child = p.get("sessionId")
            info = p.get("targetInfo", {})
            self.child_sessions[child] = {"type": info.get("type"), "url": redact(info.get("url")),
                                          "parent": msg.get("sessionId"), "attached": msg["_t"]}
            try:
                self.post("Runtime.enable", {}, child)
                self.post("Log.enable", {}, child)
                self.post("Network.enable", NET_ENABLE, child)
                self.post("Target.setAutoAttach", AUTO_ATTACH, child)
                self.post("Runtime.runIfWaitingForDebugger", {}, child)
            except OSError:
                return

    def _write(self, msg):
        data = json.dumps(msg).encode("utf-8") + b"\0"
        with self._wlock:
            os.write(self._cmd_w, data)

    def post(self, method, params=None, session=None):
        """Send without waiting for the reply (the reply is dropped)."""
        with self._lock:
            self._next += 1
            mid = self._next
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self._write(msg)

    def send(self, method, params=None, session=None, timeout=30):
        with self._lock:
            self._next += 1
            mid = self._next
            box = queue.Queue(maxsize=1)
            self._waiters[mid] = box
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self._write(msg)
        try:
            reply = box.get(timeout=timeout)
        except queue.Empty:
            with self._lock:
                self._waiters.pop(mid, None)
            raise CDPError("%s timed out after %ss" % (method, timeout))
        if "error" in reply:
            raise CDPError("%s failed: %s" % (method, json.dumps(reply["error"])))
        return reply.get("result", {})

    def drain(self, seconds=0.0):
        """Return events received so far (waiting up to `seconds` for more)."""
        out = []
        end = time.time() + seconds
        while True:
            left = end - time.time()
            try:
                out.append(self.events.get(timeout=max(0.0, left)) if left > 0 else self.events.get_nowait())
            except queue.Empty:
                break
        return out

    def evaluate(self, session, expression, await_promise=True, timeout=30):
        r = self.send("Runtime.evaluate", {"expression": expression, "awaitPromise": await_promise,
                                           "returnByValue": True}, session=session, timeout=timeout)
        if r.get("exceptionDetails"):
            raise CDPError("evaluate threw: " + json.dumps(r["exceptionDetails"].get("exception", {}).get("description")
                                                           or r["exceptionDetails"].get("text")))
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.send("Browser.close", timeout=5)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except Exception:  # noqa: BLE001
                    pass
        for fd in (self._cmd_w, self._resp_r):
            try:
                os.close(fd)
            except OSError:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)


# --------------------------------------------------------------------------- helpers
def attach(cdp, target_id):
    return cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]


def open_page(cdp, url):
    tid = cdp.send("Target.createTarget", {"url": "about:blank"})["targetId"]
    sid = attach(cdp, tid)
    for m in ("Runtime.enable", "Log.enable", "Page.enable"):
        cdp.send(m, session=sid)
    cdp.send("Page.navigate", {"url": url}, session=sid)
    return tid, sid


def _stack_urls(st):
    return [f.get("url") for f in (st or {}).get("callFrames", []) if f.get("url")][:8]


def attribute_problem(p):
    """'extension', 'extension?' (worker blob frame: the extension's worker wrapper is a blob
    URL; Twitch's own worker code comes from static.twitchcdn.net) or 'twitch'."""
    blob = " ".join([p.get("text") or "", p.get("url") or ""] + p.get("stack", []))
    if "[TAS]" in blob or "chrome-extension://" in blob or "main-world.js" in blob or "isolated-world.js" in blob:
        return "extension"
    top = (p.get("stack") or [p.get("url") or ""])[0] or ""
    if p.get("session_type") == "worker" and top.startswith("blob:"):
        return "extension?"
    return "twitch"


def collect_problems(events, sessions, session_types=None):
    """Console errors / warnings / exceptions from the given sessions (None = all)."""
    out = []
    for e in events:
        sid = e.get("sessionId")
        if sessions is not None and sid not in sessions:
            continue
        m, p = e.get("method"), e.get("params", {})
        item = None
        if m == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            item = {"kind": "exception", "text": (d.get("exception") or {}).get("description") or d.get("text"),
                    "url": d.get("url"), "stack": _stack_urls(d.get("stackTrace"))}
        elif m == "Runtime.consoleAPICalled" and p.get("type") in ("error", "warning", "assert"):
            item = {"kind": "console." + p["type"],
                    "text": " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", [])),
                    "stack": _stack_urls(p.get("stackTrace"))}
        elif m == "Log.entryAdded" and p.get("entry", {}).get("level") == "error":
            item = {"kind": "log.error", "text": p["entry"].get("text"), "url": p["entry"].get("url"),
                    "stack": _stack_urls(p["entry"].get("stackTrace"))}
        if item is None:
            continue
        item["text"] = (item.get("text") or "")[:600]
        if item.get("url"):
            item["url"] = redact(item["url"])
        item["stack"] = [redact(u) for u in item.get("stack", [])]
        item["session_type"] = (session_types or {}).get(sid, "page")
        item["source"] = attribute_problem(item)
        if "ERR_BLOCKED_BY_CLIENT" in item["text"]:
            item["source"] = "blocked-by-extension"
        out.append(item)
    return out


def find_sw_target(cdp, ext_id, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        for t in cdp.send("Target.getTargets").get("targetInfos", []):
            if t.get("type") == "service_worker" and t.get("url", "").startswith("chrome-extension://%s/" % ext_id):
                return t
        time.sleep(0.3)
    return None


def load_extension(cdp):
    return cdp.send("Extensions.loadUnpacked", {"path": ROOT}, timeout=60)["id"]


def results_dir(tag):
    d = os.path.join(ROOT, "results", datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + tag)
    os.makedirs(d, exist_ok=True)
    return d


def write_reports(outdir, report, md_lines):
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(outdir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")


# --------------------------------------------------------------------------- smoke
SW_STATE_JS = """
(async () => {
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const s = (await chrome.storage.local.get('settings')).settings || null;
  const m = chrome.runtime.getManifest();
  return { version: m.version,
           scripts: scripts.map(x => ({ id: x.id, world: x.world, runAt: x.runAt, allFrames: x.allFrames,
                                        persist: x.persistAcrossSessions, files: (x.js || []).length + (x.css || []).length })),
           manifestScripts: (m.content_scripts || []).map(c => ({ world: c.world || 'ISOLATED', js: c.js || [],
                                                                  runAt: c.run_at, allFrames: !!c.all_frames })),
           rulesets, enabled: s && s.enabled };
})()
"""

GENERAL_SCRIPTS = ["as-css-ads", "as-css-cookies", "as-site"]
DEFAULT_RULESETS = ["ads_1", "ads_curated", "client_ads", "cookie_strip", "cookies_1", "privacy_1", "privacy_curated"]

# chrome.declarativeNetRequest.testMatchOutcome (unpacked + declarativeNetRequestFeedback only):
# which static rulesets a request would match. No request is sent.
DNR_TEST_JS = """
(async () => {
  const cases = %s;
  const out = {};
  for (const [name, req] of Object.entries(cases)) {
    try {
      const r = await chrome.declarativeNetRequest.testMatchOutcome(req);
      out[name] = r.matchedRules.map(m => m.rulesetId);
    } catch (e) { out[name] = 'error: ' + e.message; }
  }
  return out;
})()
"""

SET_BLOCKING_JS = """
(async () => {
  const cur = (await chrome.storage.local.get('blocking')).blocking || {};
  await chrome.storage.local.set({ blocking: Object.assign({}, cur, %s) });
  return true;
})()
"""

SET_ENABLED_JS = """
(async () => {
  const cur = (await chrome.storage.local.get('settings')).settings || {};
  await chrome.storage.local.set({ settings: Object.assign({}, cur, { enabled: %s }) });
  return true;
})()
"""

# Source files of the MAIN-world bundle, in order (must match tools/build.py "build/main-world.js").
MAIN_FILES = [
    "src/config.js", "src/shared/settings.js", "src/shared/logger.js", "src/shared/frame.js",
    "src/core/m3u8.js", "src/core/gql.js", "src/core/processor.js", "src/worker/worker-main.js",
    "src/core/worker-source.js", "src/page/recovery.js", "src/page/page.js",
]
MAIN_BUNDLE = "build/main-world.js"

WORKER_SELFTEST_JS = """
(async () => {
  const ns = window.__TAS__;
  const parts = { m3u8Factory: ns.m3u8Factory, processorFactory: ns.processorFactory,
                  loggerFactory: ns.loggerFactory, workerMain: ns.workerMain };
  const original = `
    self.addEventListener('message', async (e) => {
      if (e.data !== 'go') return;
      // A non-Twitch URL goes through the hook to the real fetch (data: URL, no network).
      const r = await fetch('data:text/plain,hello');
      postMessage({ fetchHooked: !String(self.fetch).includes('[native code]'), originalRan: true,
                    dataFetch: await r.text() });
    });`;
  const src = ns.buildWorkerSource(parts, ns.config, { settings: ns.settings.defaults(), degraded: [] }, original);
  const blank = Uint8Array.from(atob(ns.config.blankTsBase64), c => c.charCodeAt(0)).length;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const res = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 5000);
    w.onmessage = (e) => { if (e.data && e.data.originalRan) { clearTimeout(t); resolve(e.data); } };
    w.onerror = (e) => { clearTimeout(t); resolve({ error: String(e.message) }); };
    w.postMessage('go');
  });
  w.terminate();
  return Object.assign({ blankBytes: blank, sourceLength: src.length }, res);
})()
"""

PAGE_HOOKS_JS = """
(async () => {
  const fetchReplaced = !String(window.fetch).includes('[native code]');
  const workerSubclass = Object.getPrototypeOf(window.Worker) !== Function.prototype &&
                         String(Object.getPrototypeOf(window.Worker)).includes('[native code]');
  const w = new Worker(URL.createObjectURL(new Blob(['postMessage(42)'], { type: 'text/javascript' })));
  const reply = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 5000);
    w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    w.onerror = (e) => { clearTimeout(t); resolve('error: ' + e.message); };
  });
  w.terminate();
  return { fetchReplaced, workerSubclass, plainWorkerReply: reply, namespaceGone: !('__TAS__' in window) };
})()
"""


def manifest_content_scripts():
    """Content scripts declared in manifest.json (Python side), with file existence."""
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        man = json.load(f)
    out = []
    for c in man.get("content_scripts", []):
        js = c.get("js", [])
        out.append({"world": c.get("world", "ISOLATED"), "js": js, "run_at": c.get("run_at"),
                    "all_frames": c.get("all_frames", False),
                    "missing": [p for p in js if not os.path.isfile(os.path.join(ROOT, p))]})
    return out


def serve_local_page(html):
    """Serve one HTML page on 127.0.0.1 (random port) from a temporary folder; returns (url, stop)."""
    import http.server
    import socketserver
    d = tempfile.mkdtemp(prefix="adshield-smoke-page-")
    with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=d, **kw)

        def log_message(self, *a):
            pass

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True  # an idle preconnect socket must not block shutdown()

    httpd = Server(("127.0.0.1", 0), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d/index.html" % httpd.server_address[1], httpd.shutdown


def first_simple_selector(selectors):
    for x in selectors:
        if re.match(r"^[#.]-?[A-Za-z_][A-Za-z0-9_-]*$", x):
            return x
    return None


def element_html(sel, label):
    attr = 'id="%s"' % sel[1:] if sel.startswith("#") else 'class="%s"' % sel[1:]
    return '<div %s data-t="%s">x</div>' % (attr, label)


def run_smoke(args):
    checks = []

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print("  %s %s%s" % ("PASS" if ok else "FAIL", name, (" - " + str(detail)) if detail else ""))

    cdp = PipeCDP([], headless=not args.headed)
    report = {"mode": "smoke", "started": now_iso(), "chrome": None, "checks": checks, "problems": []}
    try:
        report["chrome"] = cdp.send("Browser.getVersion").get("product")
        print("Chrome:", report["chrome"])
        cdp.send("Target.setDiscoverTargets", {"discover": True})

        mcs = manifest_content_scripts()
        report["manifest_content_scripts"] = mcs
        worlds = sorted(c["world"] for c in mcs)
        check("manifest declares MAIN + ISOLATED content scripts at document_start, all frames",
              worlds == ["ISOLATED", "MAIN"] and all(c["run_at"] == "document_start" and c["all_frames"] for c in mcs),
              [(c["world"], c["js"]) for c in mcs])
        check("manifest content-script files exist", mcs and not any(c["missing"] for c in mcs),
              [m for c in mcs for m in c["missing"]] or "ok")

        try:
            ext_id = load_extension(cdp)
        except CDPError as e:
            check("Extensions.loadUnpacked", False, str(e))
            raise
        check("Extensions.loadUnpacked", True, ext_id)

        sw = find_sw_target(cdp, ext_id)
        check("service worker running", sw is not None, sw and sw.get("url"))
        sessions = set()
        if sw:
            sw_sid = attach(cdp, sw["targetId"])
            sessions.add(sw_sid)
            cdp.send("Runtime.enable", session=sw_sid)
            cdp.send("Log.enable", session=sw_sid)
            st = None
            for _ in range(20):  # install handling (settings defaults, ruleset sync) is asynchronous
                st = cdp.evaluate(sw_sid, SW_STATE_JS)
                if st and len(st.get("scripts") or []) == len(GENERAL_SCRIPTS) and st.get("rulesets") and st.get("enabled") is not None:
                    break
                time.sleep(0.25)
            report["sw_state_initial"] = st
            check("manifest version 1.0.0", st and st.get("version") == "1.0.0", st and st.get("version"))
            ids = sorted(s["id"] for s in st.get("scripts", [])) if st else None
            check("only the general content scripts are registered (Twitch ones are static in manifest.json)",
                  ids == GENERAL_SCRIPTS, ids)
            loaded = sorted(c["world"] for c in (st or {}).get("manifestScripts", []))
            check("loaded extension reports MAIN + ISOLATED manifest content scripts", loaded == ["ISOLATED", "MAIN"], loaded)
            check("default rulesets: client_ads + general", st and sorted(st.get("rulesets") or []) == DEFAULT_RULESETS,
                  st and st.get("rulesets"))
            with open(os.path.join(ROOT, "rules", "cookie_strip.json"), encoding="utf-8") as fh:
                strip_host = json.load(fh)[0]["condition"]["requestDomains"][0]
            cases = {
                "ad": {"url": "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "type": "script", "initiator": "https://example.com"},
                "tracker": {"url": "https://www.google-analytics.com/analytics.js", "type": "script", "initiator": "https://example.com"},
                "cookie": {"url": "https://%s/p" % strip_host, "type": "image", "initiator": "https://example.com"},
                "plain": {"url": "https://example.com/style.css", "type": "stylesheet", "initiator": "https://example.com"},
                "curated_ad": {"url": "https://ads.tiktok.com/i18n/pixel/events.js", "type": "script", "initiator": "https://example.com"},
                "curated_tracker": {"url": "https://kochava.com/v1/cpi/click", "type": "xmlhttprequest", "initiator": "https://example.com"},
                "curated_first_party": {"url": "https://ads.tiktok.com/i18n/pixel/events.js", "type": "script", "initiator": "https://www.tiktok.com"},
                "curated_never": {"url": "https://cmp.quantcast.com/choice.js", "type": "script", "initiator": "https://example.com"},
            }
            dnr = cdp.evaluate(sw_sid, DNR_TEST_JS % json.dumps(cases))
            report["dnr_test"] = dnr
            check("testMatchOutcome: ad, tracker and tracking-cookie requests match; a plain request does not",
                  dnr and any(x in ("ads_1", "privacy_1") for x in dnr.get("ad", [])) and "privacy_1" in dnr.get("tracker", [])
                  and len(dnr.get("cookie", [])) > 0 and dnr.get("plain") == [], dnr)
            check("testMatchOutcome: curated hosts blocked third-party only; [never] host (excluded) not blocked by them",
                  dnr and "ads_curated" in dnr.get("curated_ad", []) and "privacy_curated" in dnr.get("curated_tracker", [])
                  and "ads_curated" not in dnr.get("curated_first_party", [])
                  and not any(x in ("ads_curated", "privacy_curated") for x in dnr.get("curated_never", [])), dnr)

            cdp.evaluate(sw_sid, SET_ENABLED_JS % "false")
            off = None
            for _ in range(20):
                time.sleep(0.25)
                off = cdp.evaluate(sw_sid, SW_STATE_JS)
                if off and not off["rulesets"]:
                    break
            report["sw_state_disabled"] = off
            check("switching OFF disables rulesets (and registers no scripts)", off and not off["scripts"] and not off["rulesets"],
                  off and {"scripts": len(off["scripts"]), "rulesets": off["rulesets"]})
            cdp.evaluate(sw_sid, SET_ENABLED_JS % "true")
            on = None
            for _ in range(20):
                time.sleep(0.25)
                on = cdp.evaluate(sw_sid, SW_STATE_JS)
                if on and len(on["rulesets"]) == len(DEFAULT_RULESETS) and len(on["scripts"]) == len(GENERAL_SCRIPTS):
                    break
            check("switching ON enables the rulesets and general scripts again",
                  on and sorted(x["id"] for x in on["scripts"]) == GENERAL_SCRIPTS and sorted(on["rulesets"]) == DEFAULT_RULESETS,
                  on and {"scripts": len(on["scripts"]), "rulesets": on["rulesets"]})

        base = "chrome-extension://%s/" % ext_id
        _, popup_sid = open_page(cdp, base + "src/popup/popup.html")
        sessions.add(popup_sid)
        time.sleep(2.0)
        popup = cdp.evaluate(popup_sid, "({ site: document.getElementById('site-detail').textContent,"
                                        " enabled: document.getElementById('enabled').checked,"
                                        " rows: document.querySelectorAll('tbody tr').length,"
                                        " version: document.getElementById('version').textContent })")
        report["popup"] = popup
        check("popup renders", popup and popup["rows"] == 9 and popup["site"] != "", popup)

        _, opt_sid = open_page(cdp, base + "src/options/options.html")
        sessions.add(opt_sid)
        time.sleep(2.0)
        opts = cdp.evaluate(opt_sid, "({ toggles: document.querySelectorAll('input[data-key]').length,"
                                     " btoggles: document.querySelectorAll('input[data-bkey]').length,"
                                     " lists: document.querySelectorAll('#lists li').length,"
                                     " order: document.getElementById('playerTypes').value })")
        report["options"] = opts
        check("options page renders", opts and opts["toggles"] == 7 and opts["btoggles"] == 5 and opts["lists"] == 3
              and opts["order"].split("\n")[0] == "site", opts)
        bad = cdp.evaluate(opt_sid, "(() => { document.getElementById('playerTypes').value = 'autoplay\\nbogus';"
                                    " document.getElementById('pt-save').click();"
                                    " return document.querySelectorAll('#pt-errors li').length; })()")
        check("options rejects an invalid playerType list", bad and bad >= 2, "%s error(s) shown" % bad)

        # General blocking on a real http page served from 127.0.0.1 (no outside traffic): the
        # registered generic CSS hides an EasyList ad element and a cookie-list element, a plain
        # element stays visible, and the page script reported the page to the background.
        with open(os.path.join(ROOT, "rules", "cosmetic", "generic.json"), encoding="utf-8") as fh:
            gen = json.load(fh)
        ad_sel, ck_sel = first_simple_selector(gen["ads"]), first_simple_selector(gen["cookies"])
        page_url, stop_page = serve_local_page("<!doctype html><title>t</title><link rel=\"icon\" href=\"data:,\">" + element_html(ad_sel, "ad")
                                               + element_html(ck_sel, "cookie") + '<div data-t="plain">x</div>')
        try:
            _, gp_sid = open_page(cdp, page_url)
            sessions.add(gp_sid)
            time.sleep(2.5)
            vis = cdp.evaluate(gp_sid, "Object.fromEntries([...document.querySelectorAll('[data-t]')]"
                                       ".map(e => [e.dataset.t, getComputedStyle(e).display]))")
        finally:
            stop_page()
        report["cosmetic_page"] = {"selectors": [ad_sel, ck_sel], "display": vis}
        check("generic cosmetic CSS hides an ad and a cookie-banner element, plain element visible",
              vis and vis.get("ad") == "none" and vis.get("cookie") == "none" and vis.get("plain") == "block", vis)
        if sw:
            pages = cdp.evaluate(sw_sid, "chrome.storage.session.get(null).then(o => Object.keys(o).filter(k => k.startsWith('page:')).length)")
            check("page script reported the page to the background", pages and pages >= 1, pages)
            cdp.evaluate(sw_sid, SET_BLOCKING_JS % json.dumps({"trackers": False, "allowlist": ["allowed.example"]}))
            dnr2 = None
            for _ in range(20):
                time.sleep(0.25)
                dnr2 = cdp.evaluate(sw_sid, DNR_TEST_JS % json.dumps({
                    "cookie": cases["cookie"],
                    "allowlisted": {"url": "https://allowed.example/", "type": "main_frame"}}))
                if dnr2 and dnr2.get("cookie") == ["cookie_strip"] and dnr2.get("allowlisted"):
                    break
            report["dnr_test_trackers_off"] = dnr2
            check("trackers off: tracker request only gets its cookies stripped; allowlist rule matches",
                  dnr2 and dnr2.get("cookie") == ["cookie_strip"] and dnr2.get("allowlisted") == ["_dynamic"], dnr2)
            cdp.evaluate(sw_sid, SET_BLOCKING_JS % json.dumps({"trackers": True, "allowlist": [], "autoRejectCookies": True}))
            ac = None
            for _ in range(20):
                time.sleep(0.25)
                ac = cdp.evaluate(sw_sid, SW_STATE_JS)
                if ac and "as-autoconsent" in [x["id"] for x in ac["scripts"]]:
                    break
            check("auto-reject on registers the autoconsent content script",
                  ac and "as-autoconsent" in [x["id"] for x in ac["scripts"]], ac and [x["id"] for x in ac["scripts"]])
            # A page load with autoconsent running (init/rules round trip); errors show up in the
            # final console check. No consent pop-up here, so nothing is clicked.
            page_url2, stop_page2 = serve_local_page('<!doctype html><title>t</title><link rel="icon" href="data:,"><p>x</p>')
            try:
                _, ac_sid = open_page(cdp, page_url2)
                sessions.add(ac_sid)
                time.sleep(3.0)
            finally:
                stop_page2()
            cdp.evaluate(sw_sid, SET_BLOCKING_JS % json.dumps({"autoRejectCookies": False}))

        # Page-script self-test on about:blank (no network): the MAIN-world files load, the
        # generated worker source runs in a real Chrome worker with fetch hooked, and after
        # page.js window.fetch / window.Worker are replaced while non-Twitch workers still work.
        _, blank_sid = open_page(cdp, "about:blank")
        sessions.add(blank_sid)
        time.sleep(0.5)
        for f in MAIN_FILES[:-1]:
            with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
                cdp.evaluate(blank_sid, fh.read(), await_promise=False)
        built = cdp.evaluate(blank_sid, WORKER_SELFTEST_JS, timeout=20)
        report["worker_selftest"] = built
        check("generated worker source runs in a real worker with fetch hooked",
              built and built.get("fetchHooked") and built.get("originalRan") and built.get("blankBytes") == 188, built)
        with open(os.path.join(ROOT, MAIN_FILES[-1]), encoding="utf-8") as fh:
            cdp.evaluate(blank_sid, fh.read(), await_promise=False)
        hooks = cdp.evaluate(blank_sid, PAGE_HOOKS_JS, timeout=20)
        report["page_hooks"] = hooks
        check("page.js replaces fetch and Worker; other workers unaffected; namespace removed",
              hooks and hooks.get("fetchReplaced") and hooks.get("workerSubclass") and hooks.get("plainWorkerReply") == 42
              and hooks.get("namespaceGone"), hooks)

        # The same with the built bundle that manifest.json actually injects.
        bundle_path = os.path.join(ROOT, MAIN_BUNDLE)
        if os.path.isfile(bundle_path):
            _, bundle_sid = open_page(cdp, "about:blank")
            sessions.add(bundle_sid)
            time.sleep(0.5)
            with open(bundle_path, encoding="utf-8") as fh:
                cdp.evaluate(bundle_sid, fh.read(), await_promise=False)
            bh = cdp.evaluate(bundle_sid, PAGE_HOOKS_JS, timeout=20)
            report["bundle_hooks"] = bh
            check("%s replaces fetch and Worker; other workers unaffected" % MAIN_BUNDLE,
                  bh and bh.get("fetchReplaced") and bh.get("workerSubclass") and bh.get("plainWorkerReply") == 42
                  and bh.get("namespaceGone"), bh)
        else:
            check("%s exists (run tools/build.py)" % MAIN_BUNDLE, False)

        time.sleep(0.5)
        problems = collect_problems(cdp.drain(0.5), sessions)
        report["problems"] = problems
        check("no console errors / exceptions in extension pages and service worker", not problems,
              [p["text"][:200] for p in problems[:5]])
    except Exception as e:  # noqa: BLE001
        report["error"] = "%s: %s" % (type(e).__name__, e)
        report["chrome_stderr_tail"] = cdp.stderr_tail[-15:]
        print("ERROR:", report["error"])
    finally:
        cdp.close()
    ok = bool(checks) and all(c["ok"] for c in checks) and "error" not in report
    report["result"] = "PASS" if ok else "FAIL"
    report["finished"] = now_iso()
    outdir = results_dir("smoke")
    md = ["# Smoke test %s" % report["started"], "", "Chrome: %s" % report["chrome"], "", "| Check | Result | Detail |", "|---|---|---|"]
    for c in checks:
        md.append("| %s | %s | %s |" % (c["name"], "PASS" if c["ok"] else "FAIL", str(c["detail"]).replace("|", "/")[:200]))
    if "error" in report:
        md += ["", "Error: `%s`" % report["error"]]
    md += ["", "**Result: %s**" % report["result"]]
    write_reports(outdir, report, md)
    print("SMOKE %s  (%s)" % (report["result"], os.path.relpath(outdir, ROOT)))
    return 0 if ok else 1


# --------------------------------------------------------------------------- live: ad markers
def load_ad_markers():
    """Ad-marker strings the extension uses, read from src/config.js (adMarkers,
    adDaterangeClasses, adSegmentTitlePrefixes). The fallback is a copy of config.js as of
    2026-11-11. 'twitch-trigger' DATERANGE is in every live playlist and is NOT an ad."""
    fallback = {"adMarkers": ["stitched-ad", "EXT-X-CUE-OUT", "twitch-stitched", 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'],
                "adDaterangeClasses": ["twitch-stitched-ad", "twitch-maf-ad"],
                "adSegmentTitlePrefixes": ["Amazon"]}
    out = {"source": "src/config.js"}
    try:
        with open(CONFIG_JS, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        src = ""
    for key, fb in fallback.items():
        m = re.search(key + r"\s*:\s*\[(.*?)\]", src, re.S)
        vals = re.findall(r"'([^']*)'", m.group(1)) if m else []
        if not vals:
            vals = fb
            out["source"] = "fallback (config.js not parsed)"
        out[key] = vals
    return out


AD_MARKERS = load_ad_markers()
INFO_MARKERS = ["X-TV-TWITCH-AD", "twitch-ad-quartile", "twitch-trigger"]


def scan_playlist(body):
    """Count ad marker lines in an m3u8 body. Returns a dict of counts only."""
    master = "#EXT-X-STREAM-INF" in body
    res = {"master": master, "bytes": len(body), "ad_lines": 0, "ad_segments": 0, "segments": 0,
           "non_live_segments": 0, "hits": {}, "info": {}}
    if master:
        return res
    classes = AD_MARKERS["adDaterangeClasses"]
    prefixes = AD_MARKERS["adSegmentTitlePrefixes"]
    for line in body.splitlines():
        hit = [mk for mk in AD_MARKERS["adMarkers"] if mk in line]
        if line.startswith("#EXT-X-DATERANGE"):
            cm = re.search(r'CLASS="([^"]*)"', line)
            if cm and cm.group(1) in classes:
                hit.append("CLASS=" + cm.group(1))
        if hit:
            res["ad_lines"] += 1
            for h in set(hit):
                res["hits"][h] = res["hits"].get(h, 0) + 1
        for mk in INFO_MARKERS:
            if mk in line:
                res["info"][mk] = res["info"].get(mk, 0) + 1
        if line.startswith("#EXTINF"):
            res["segments"] += 1
            title = line.split(",", 1)[1] if "," in line else ""
            if any(title.startswith(p) for p in prefixes):
                res["ad_segments"] += 1
            if title.strip() != "live":
                res["non_live_segments"] += 1
    res["has_ad"] = res["ad_lines"] > 0 or res["ad_segments"] > 0
    return res


# --------------------------------------------------------------------------- live: page JS
_TW_JSON = json.dumps(TWITCH)

PAGE_PRELUDE = """
const TW = %s;
const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
const vis = el => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05; };
const q1 = sels => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
const player = () => q1(TW.player);
const mainVideo = () => {
  const p = player(); let v = p && p.querySelector('video');
  if (!v) { let best = null, area = 0;
    for (const x of document.querySelectorAll('video')) { const r = x.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = x; } }
    v = best; }
  return v;
};
""" % _TW_JSON

# Locate (and optionally click) the cookie banner's REJECT button. Never matches "Accept".
CONSENT_JS = "(() => {" + PAGE_PRELUDE + """
const mode = %s;
const rej = new RegExp(TW.consent_reject_re, 'i'), ctx = new RegExp(TW.consent_context_re, 'i');
for (const b of document.querySelectorAll('button, [role="button"], a[role="button"]')) {
  const t = norm(b.innerText || b.textContent);
  if (!rej.test(t) || /accept|akzept|agree|zustimm|allow/i.test(t)) continue;
  let c = b.parentElement, ok = false;
  for (let i = 0; i < 8 && c && c !== document.body; i++, c = c.parentElement) {
    const attrs = (c.getAttribute('data-a-target') || '') + ' ' + String(c.className || '') + ' ' + (c.id || '') + ' ' + (c.getAttribute('aria-label') || '');
    if (ctx.test(attrs) || ctx.test(norm(c.innerText).slice(0, 3000))) { ok = true; break; }
  }
  if (!ok || !vis(b)) continue;
  if (mode === 'click') { b.click(); return { text: t, clicked: 'js' }; }
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { text: t, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
return null;
})()"""

MATURE_JS = "(() => {" + PAGE_PRELUDE + """
const re = new RegExp(TW.mature_text_re, 'i');
let b = q1(TW.mature_buttons);
if (!b) b = [...document.querySelectorAll('button')].find(x => re.test(norm(x.innerText || x.textContent)) && vis(x));
if (!b || !vis(b)) return null;
b.click();
return { text: norm(b.innerText || b.textContent) };
})()"""

PLAY_JS = "(async () => {" + PAGE_PRELUDE + """
const v = mainVideo(); if (!v) return { video: false };
const before = { paused: v.paused, muted: v.muted, readyState: v.readyState };
if (v.paused) { v.muted = true; try { await v.play(); before.play = 'ok'; } catch (e) { before.play = String(e && e.name); } }
before.pausedAfter = v.paused;
return before;
})()"""

# Called every ~2 s: video state, ad UI, toast, chat, points. Installs (once per document) a
# MutationObserver that counts added chat lines, because Twitch caps the chat DOM.
STATE_JS = "(() => {" + PAGE_PRELUDE + """
const H = window.__tasHarness || (window.__tasHarness = { chatAdded: 0, obs: null });
if (!H.obs && document.body) {
  H.obs = new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    H.chatAdded += n.matches(TW.chat_line) ? 1 : n.querySelectorAll(TW.chat_line).length; } });
  H.obs.observe(document.body, { childList: true, subtree: true });
}
const v = mainVideo(), p = player();
const video = v ? { t: v.currentTime, paused: v.paused, ended: v.ended, readyState: v.readyState,
  w: v.videoWidth, h: v.videoHeight, muted: v.muted, inPlayer: !!(p && p.contains(v)),
  buffered: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(2) : 0 } : null;
const adEls = TW.ad_ui.flatMap(s => [...document.querySelectorAll(s)]).filter(vis);
let adText = null;
if (p) { const re = new RegExp(TW.ad_text_re, 'i');
  for (const el of p.querySelectorAll('span, p, div, strong')) {
    if (el.children.length || el.closest(TW.toast)) continue;
    const t = norm(el.textContent);
    if (t && t.length < 40 && re.test(t) && vis(el)) { adText = t; break; } } }
const tre = new RegExp(TW.toast_re, 'i');
const toasts = [...document.querySelectorAll(TW.toast)].filter(e => tre.test(e.textContent || ''))
  .map(e => ({ text: (e.textContent || '').slice(0, 120), visible: vis(e) }));
return {
  url: location.pathname, video, adUi: adEls.length > 0 || !!adText,
  adUiWhat: adEls.map(e => e.getAttribute('data-a-target') || e.getAttribute('data-test-selector')).concat(adText ? ['text:' + adText] : []).slice(0, 4),
  toasts, chat: !!document.querySelector(TW.chat_present), chatLines: document.querySelectorAll(TW.chat_line).length,
  chatAdded: H.chatAdded, points: !!document.querySelector(TW.points), loggedOut: !!document.querySelector(TW.logged_out),
  standaloneAdVideosVisible: [...document.querySelectorAll('video')].filter(x =>
     /media-amazon\\.com|amazon-adsystem\\.com/.test(x.currentSrc || x.src || '') && vis(x)).length,
  viewport: [innerWidth, innerHeight], title: document.title.slice(0, 120)
};
})()"""


def chrome_usage(root_pid):
    """CPU% and RSS (MB) summed over Chrome's process tree, via ps."""
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,%cpu=,rss="], capture_output=True, text=True, timeout=5).stdout
    except Exception:  # noqa: BLE001
        return None
    rows = {}
    children = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) != 4:
            continue
        pid, ppid = int(parts[0]), int(parts[1])
        rows[pid] = (float(parts[2]), int(parts[3]))
        children.setdefault(ppid, []).append(pid)
    total_cpu, total_rss, stack, seen = 0.0, 0, [root_pid], set()
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        if p in rows:
            total_cpu += rows[p][0]
            total_rss += rows[p][1]
        stack.extend(children.get(p, []))
    return {"cpu_percent": round(total_cpu, 1), "rss_mb": round(total_rss / 1024.0, 1), "processes": len(seen)}


# --------------------------------------------------------------------------- live: recorder
class LiveRecorder:
    def __init__(self, cdp, sid, outdir, label):
        self.cdp, self.sid, self.outdir, self.label = cdp, sid, outdir, label
        self.phase = "start"
        self.requests = {}       # (sessionId, requestId) -> entry
        self.network = []
        self.playlists = []      # one entry per m3u8 response (counts only)
        self.tas_console = []
        self.problems = []
        self.samples = []        # full samples (metrics, CPU) every 10 s
        self.states = []         # fast samples (video, ad UI, toast, chat) every 2 s
        self.screens = []
        self.gates = []          # consent / mature / play actions

    def session_type(self, sid):
        if sid == self.sid:
            return "page"
        info = self.cdp.child_sessions.get(sid)
        return info.get("type") if info else None

    def pump(self, seconds):
        events = self.cdp.drain(seconds)
        types = {s: (i.get("type") or "?") for s, i in list(self.cdp.child_sessions.items())}
        types[self.sid] = "page"
        self.problems.extend(dict(p, phase=self.phase) for p in collect_problems(events, set(types), types))
        finished = []
        for e in events:
            sid = e.get("sessionId")
            if sid not in types:
                continue
            m, p = e.get("method"), e.get("params", {})
            key = (sid, p.get("requestId"))
            if m == "Network.requestWillBeSent":
                url = p.get("request", {}).get("url", "")
                if INTERESTING.search(url):
                    entry = {"t": e["_t"], "phase": self.phase, "session": types[sid], "url": redact(url),
                             "method": p["request"].get("method"), "type": p.get("type")}
                    body = p["request"].get("postData") or ""
                    if "gql.twitch.tv" in url:
                        ops = re.findall(r'"operationName"\s*:\s*"([^"]+)"', body)
                        pts = re.findall(r'"playerType"\s*:\s*"([^"]+)"', body)
                        entry["gql_ops"] = sorted(set(ops))[:10]
                        if pts:
                            entry["playerTypes"] = pts
                    self.requests[key] = entry
                    self.network.append(entry)
            elif m == "Network.responseReceived" and key in self.requests:
                self.requests[key]["status"] = p.get("response", {}).get("status")
            elif m == "Network.loadingFinished" and key in self.requests:
                if ".m3u8" in self.requests[key]["url"]:
                    finished.append(key)
            elif m == "Network.loadingFailed" and key in self.requests:
                r = self.requests[key]
                r["failed"] = p.get("errorText")
                if p.get("blockedReason"):
                    r["blocked"] = p["blockedReason"]
            elif m == "Runtime.consoleAPICalled":
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
                if "[TAS]" in text:
                    self.tas_console.append({"t": e["_t"], "phase": self.phase, "session": types[sid],
                                             "type": p.get("type"), "text": text[:500]})
        for key in finished:
            self._scan_body(key)

    def _scan_body(self, key):
        entry = self.requests[key]
        pl = {"t": entry["t"], "phase": entry["phase"], "session": entry["session"],
              "host": re.sub(r"^https?://([^/]+).*$", r"\1", entry["url"])}
        try:
            r = self.cdp.send("Network.getResponseBody", {"requestId": key[1]}, session=key[0], timeout=10)
            body = base64.b64decode(r["body"]).decode("utf-8", "replace") if r.get("base64Encoded") else r.get("body", "")
            pl.update(scan_playlist(body))
        except CDPError as e:
            pl["body_error"] = str(e)[:120]
        entry["playlist"] = {k: pl.get(k) for k in ("master", "has_ad", "ad_lines", "ad_segments")}
        self.playlists.append(pl)

    def state(self):
        try:
            s = self.cdp.evaluate(self.sid, STATE_JS, timeout=10)
        except CDPError as e:
            s = {"error": str(e)[:200]}
        s = s or {}
        s["t"] = time.time()
        s["phase"] = self.phase
        self.states.append(s)
        return s

    def sample(self):
        s = {"t": time.time(), "phase": self.phase}
        try:
            metrics = self.cdp.send("Performance.getMetrics", session=self.sid).get("metrics", [])
            m = {x["name"]: x["value"] for x in metrics}
            s["JSHeapUsedSize_mb"] = round(m.get("JSHeapUsedSize", 0) / 1048576.0, 1)
            s["Nodes"] = m.get("Nodes")
            s["TaskDuration"] = m.get("TaskDuration")
        except CDPError as e:
            s["metrics_error"] = str(e)
        s["chrome"] = chrome_usage(self.cdp.proc.pid)
        self.samples.append(s)
        return s

    def screenshot(self, name):
        try:
            data = self.cdp.send("Page.captureScreenshot", {"format": "png"}, session=self.sid, timeout=20)["data"]
            path = os.path.join(self.outdir, "%s-%s.png" % (self.label, name))
            with open(path, "wb") as f:
                f.write(base64.b64decode(data))
            self.screens.append(os.path.basename(path))
        except CDPError:
            pass

    def trusted_click(self, x, y):
        for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
            self.cdp.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left",
                                                       "clickCount": 0 if typ == "mouseMoved" else 1}, session=self.sid)

    def handle_gates(self):
        """Reject the cookie banner (never accept) and pass the mature-content gate."""
        acted = False
        try:
            c = self.cdp.evaluate(self.sid, CONSENT_JS % json.dumps("locate"), timeout=10)
        except CDPError as e:
            c = None
            self.gates.append({"phase": self.phase, "what": "consent", "error": str(e)[:200]})
        if c:
            entry = {"t": time.time(), "phase": self.phase, "what": "consent", "button": c.get("text")}
            try:
                self.trusted_click(c["x"], c["y"])
                entry["clicked"] = "trusted"
            except CDPError as e:
                entry["click_error"] = str(e)[:120]
            self.pump(1.5)
            still = self.cdp.evaluate(self.sid, CONSENT_JS % json.dumps("locate"), timeout=10)
            if still:
                fb = self.cdp.evaluate(self.sid, CONSENT_JS % json.dumps("click"), timeout=10)
                entry["clicked"] = "trusted+js" if fb else entry.get("clicked")
                self.pump(1.5)
                still = self.cdp.evaluate(self.sid, CONSENT_JS % json.dumps("locate"), timeout=10)
            entry["banner_gone"] = not still
            self.gates.append(entry)
            print("  [%s] cookie banner: clicked %r, gone=%s" % (self.label, c.get("text"), entry["banner_gone"]))
            acted = True
        try:
            mt = self.cdp.evaluate(self.sid, MATURE_JS, timeout=10)
        except CDPError:
            mt = None
        if mt:
            self.gates.append({"t": time.time(), "phase": self.phase, "what": "mature-gate", "button": mt.get("text")})
            print("  [%s] mature gate: clicked %r" % (self.label, mt.get("text")))
            acted = True
        return acted

    def ensure_playing(self):
        try:
            r = self.cdp.evaluate(self.sid, PLAY_JS, timeout=15)
        except CDPError as e:
            r = {"error": str(e)[:200]}
        if r and (r.get("play") or r.get("error")):
            self.gates.append(dict(r, t=time.time(), phase=self.phase, what="play()"))
        return r

    def prepare(self, min_wait=8, max_wait=25):
        """After a navigation: wait for the page, handle consent / mature gate, start the video."""
        start = time.time()
        while time.time() - start < max_wait:
            self.pump(1.0)
            acted = self.handle_gates()
            s = self.state()
            v = s.get("video")
            if not acted and time.time() - start >= min_wait and v and v.get("readyState", 0) >= 2:
                break
        self.ensure_playing()
        self.pump(1.0)


# --------------------------------------------------------------------------- live: phases
def watch(rec, seconds, phase, screenshot_every=30, sample_every=10, state_every=2):
    """Watch for `seconds`: fast state every 2 s, metrics every 10 s, screenshot every 30 s."""
    rec.phase = phase
    start = time.time()
    first_state = len(rec.states)
    first_pl = len(rec.playlists)
    next_state = next_sample = next_shot = start
    next_gate = start + 10
    while time.time() - start < seconds:
        now = time.time()
        if now >= next_state:
            s = rec.state()
            next_state += state_every
            v = s.get("video")
            if v and v.get("paused") and now - start > 6 and len(rec.states) - first_state >= 3:
                prev = rec.states[-2].get("video") or {}
                if prev.get("paused"):
                    rec.ensure_playing()
        if now >= next_gate:
            rec.handle_gates()
            next_gate += 10
        if now >= next_sample:
            rec.sample()
            next_sample += sample_every
        if now >= next_shot:
            rec.screenshot("%s-%03d" % (phase, int(now - start)))
            next_shot += screenshot_every
        rec.pump(0.4)
    return summarize_phase(rec, phase, seconds, rec.states[first_state:], rec.playlists[first_pl:])


def summarize_phase(rec, phase, seconds, states, playlists):
    advanced, stalls, ad_ui_s, prev = 0.0, 0, 0.0, None
    for s in states:
        v = s.get("video")
        if prev is not None:
            dt = s["t"] - prev["t"]
            pv = prev.get("video")
            if s.get("adUi"):
                ad_ui_s += dt
            if v and pv:
                d = v["t"] - pv["t"]
                if 0 < d <= dt + 3:
                    advanced += d
                elif d == 0 and not v.get("paused"):
                    stalls += 1
        prev = s
    vids = [s["video"] for s in states if s.get("video")]
    toasts = sorted({t["text"] for s in states for t in (s.get("toasts") or [])})
    chat_added = [s.get("chatAdded") for s in states if s.get("chatAdded") is not None]
    media = [p for p in playlists if p.get("master") is False]
    last = states[-1] if states else {}
    res = {
        "phase": phase, "seconds": seconds, "video_advanced_s": round(advanced, 1) if vids else None,
        "ok": bool(vids) and advanced > seconds * 0.5,
        "video_samples": len(vids), "paused_samples": sum(1 for v in vids if v.get("paused")), "stall_samples": stalls,
        "video_height": vids[-1].get("h") if vids else None,
        "ad_ui_visible_s": round(ad_ui_s, 1),
        "ad_ui_what": sorted({w for s in states for w in (s.get("adUiWhat") or [])})[:6],
        "toasts": toasts, "toast_visible_samples": sum(1 for s in states if any(t.get("visible") for t in (s.get("toasts") or []))),
        "media_playlists": len(media), "media_playlists_with_ads": sum(1 for p in media if p.get("has_ad")),
        "chat_present": last.get("chat"), "chat_lines_now": last.get("chatLines"),
        "chat_lines_added": (chat_added[-1] - chat_added[0]) if len(chat_added) >= 2 and chat_added[-1] >= chat_added[0] else (chat_added[-1] if chat_added else None),
        "url": last.get("url"),
    }
    return res


def goto(rec, url, phase):
    rec.phase = phase
    rec.cdp.send("Page.navigate", {"url": url}, session=rec.sid)
    rec.prepare()


def spa_navigate(rec, path, phase):
    """In-app navigation (React Router listens to popstate); falls back to Page.navigate."""
    rec.phase = phase
    before = rec.cdp.evaluate(rec.sid, "location.pathname")
    rec.cdp.evaluate(rec.sid, "history.pushState({}, '', %s); dispatchEvent(new PopStateEvent('popstate', { state: {} })); true"
                     % json.dumps(path))
    method = "spa"
    for _ in range(10):
        rec.pump(1.0)
        s = rec.state()
        v = s.get("video")
        if v and v.get("readyState", 0) >= 2 and not v.get("paused") and (s.get("url") or "").lower() == path.lower():
            break
    else:
        method = "spa-then-full-load"
        rec.cdp.send("Page.navigate", {"url": rec.base + path}, session=rec.sid)
    rec.prepare(min_wait=4)
    after = rec.cdp.evaluate(rec.sid, "location.pathname")
    return {"from": before, "to": after, "method": method}


def setup_window(cdp, tid, sid):
    """Make the page a 1920x1080 desktop layout: resize the window, then emulate if the screen
    is smaller than that."""
    info = {}
    try:
        wid = cdp.send("Browser.getWindowForTarget", {"targetId": tid})["windowId"]
        cdp.send("Browser.setWindowBounds", {"windowId": wid, "bounds": {"windowState": "normal"}})
        cdp.send("Browser.setWindowBounds", {"windowId": wid, "bounds": {"left": 0, "top": 0, "width": VIEWPORT[0],
                                                                          "height": VIEWPORT[1]}})
        info["window"] = cdp.send("Browser.getWindowBounds", {"windowId": wid}).get("bounds")
    except CDPError as e:
        info["window_error"] = str(e)[:200]
    try:
        inner = cdp.evaluate(sid, "[innerWidth, innerHeight]")
    except CDPError:
        inner = None
    info["inner_before"] = inner
    # A laptop screen caps the real window (e.g. 1920x746 inner); emulate the full size then.
    if not inner or inner[0] < VIEWPORT[0] - 40 or inner[1] < VIEWPORT[1] - 180:
        cdp.send("Emulation.setDeviceMetricsOverride", {"width": VIEWPORT[0], "height": VIEWPORT[1], "deviceScaleFactor": 1,
                                                         "mobile": False, "screenWidth": VIEWPORT[0], "screenHeight": VIEWPORT[1]},
                 session=sid)
        info["emulated"] = list(VIEWPORT)
    return info


def run_scenario(args, with_extension, outdir):
    label = "ext" if with_extension else "baseline"
    cdp = PipeCDP(LIVE_FLAGS, headless=args.headless, auto_attach=True)
    result = {"label": label, "with_extension": with_extension, "phases": [], "started": now_iso()}
    rec = None
    try:
        result["chrome"] = cdp.send("Browser.getVersion").get("product")
        if with_extension:
            result["extension_id"] = load_extension(cdp)
            if args.debug_logging:
                sw = find_sw_target(cdp, result["extension_id"])
                if sw:
                    sw_sid = attach(cdp, sw["targetId"])
                    cdp.evaluate(sw_sid, "(async () => { const c = (await chrome.storage.local.get('settings')).settings || {};"
                                         " await chrome.storage.local.set({ settings: Object.assign({}, c, { debug: true }) }); })()")
        tid = cdp.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = attach(cdp, tid)
        for m in ("Runtime.enable", "Log.enable", "Page.enable", "Performance.enable"):
            cdp.send(m, session=sid)
        cdp.send("Network.enable", NET_ENABLE, session=sid)
        cdp.send("Target.setAutoAttach", AUTO_ATTACH, session=sid)
        result["viewport"] = setup_window(cdp, tid, sid)
        rec = LiveRecorder(cdp, sid, outdir, label)
        base = args.base_url.rstrip("/")
        rec.base = base

        def phase(name, fn):
            """Run one phase; an error is recorded for that phase and the run continues."""
            try:
                res = fn()
            except Exception as e:  # noqa: BLE001
                res = {"phase": name, "ok": False, "error": "%s: %s" % (type(e).__name__, e)}
            result["phases"].append(res)
            print("  [%s] %s: advanced %s s, ad UI %s s, playlists %s (with ads %s), chat +%s%s" % (
                label, name, res.get("video_advanced_s"), res.get("ad_ui_visible_s"), res.get("media_playlists"),
                res.get("media_playlists_with_ads"), res.get("chat_lines_added"),
                (" ERROR " + res["error"]) if res.get("error") else (" " + res["note"] if res.get("note") else "")))
            return res

        def p_watch():
            goto(rec, "%s/%s" % (base, args.live), "watch")
            return watch(rec, args.minutes * 60, "watch")

        def p_quality():
            # Quality switch through localStorage + reload (the player reads video-quality at start).
            cdp.evaluate(sid, "localStorage.setItem('video-quality', JSON.stringify({default: '480p30'})); true")
            try:
                rec.phase = "quality-480p"
                cdp.send("Page.reload", session=sid)
                rec.prepare()
                q = watch(rec, 40, "quality-480p")
                q["quality_ok"] = bool(q.get("video_height") and q["video_height"] <= 480)
                q["note"] = "height %s" % q.get("video_height")
                return q
            finally:
                cdp.evaluate(sid, "localStorage.removeItem('video-quality'); true")

        def p_refresh():
            rec.phase = "refresh"
            cdp.send("Page.reload", session=sid)
            rec.prepare()
            return watch(rec, 40, "refresh")

        def p_switch():
            if not args.switch_to:
                return {"phase": "channel-switch", "ok": None, "note": "NOT RUN (no --switch-to)"}
            nav = spa_navigate(rec, "/" + args.switch_to, "channel-switch")
            r = watch(rec, 60, "channel-switch")
            r["navigation"] = nav
            r["navigation_ok"] = (nav["to"] or "").lower() == ("/" + args.switch_to).lower() and r["ok"]
            r["note"] = "%s -> %s via %s" % (nav["from"], nav["to"], nav["method"])
            return r

        def p_vod():
            if not args.vod:
                return {"phase": "vod", "ok": None, "note": "NOT RUN (no --vod)"}
            goto(rec, args.vod, "vod")
            return watch(rec, 60, "vod")

        phase("watch", p_watch)
        phase("quality-480p", p_quality)
        phase("refresh", p_refresh)
        phase("channel-switch", p_switch)
        phase("vod", p_vod)

        rec.phase = "end"
        result["page_health_end"] = rec.state()
        rec.pump(1.0)
    except Exception as e:  # noqa: BLE001
        result["error"] = "%s: %s" % (type(e).__name__, e)
        result["chrome_stderr_tail"] = cdp.stderr_tail[-15:]
    finally:
        if rec is not None:
            collect_run(result, rec, cdp)
        cdp.close()
    result["finished"] = now_iso()
    return result


def collect_run(result, rec, cdp):
    net = rec.network
    media = [p for p in rec.playlists if p.get("master") is False]
    kinds = {}
    for info in cdp.child_sessions.values():
        kinds[info.get("type")] = kinds.get(info.get("type"), 0) + 1
    hits, info_hits = {}, {}
    for p in media:
        for k, n in (p.get("hits") or {}).items():
            hits[k] = hits.get(k, 0) + n
        for k, n in (p.get("info") or {}).items():
            info_hits[k] = info_hits.get(k, 0) + n
    src = {}
    for pr in rec.problems:
        src[pr["source"]] = src.get(pr["source"], 0) + 1
    result["attached_sessions"] = {"by_type": kinds,
                                   "workers": [i for i in cdp.child_sessions.values() if i.get("type") == "worker"][:20]}
    result["network_summary"] = {
        "usher": sum(1 for r in net if "usher.ttvnw.net" in r["url"]),
        "usher_from_worker": sum(1 for r in net if "usher.ttvnw.net" in r["url"] and r["session"] == "worker"),
        "m3u8": sum(1 for r in net if ".m3u8" in r["url"]),
        "m3u8_from_worker": sum(1 for r in net if ".m3u8" in r["url"] and r["session"] == "worker"),
        "gql_token": sum(1 for r in net if "PlaybackAccessToken" in " ".join(r.get("gql_ops") or [])),
        "edge_ads": sum(1 for r in net if "edge.ads.twitch.tv" in r["url"]),
        "edge_ads_blocked": sum(1 for r in net if "edge.ads.twitch.tv" in r["url"] and r.get("blocked")),
        "gql_playerTypes": sorted({pt for r in net for pt in (r.get("playerTypes") or [])}),
        "gql_playerTypes_by_session": sorted({"%s:%s" % (r["session"], pt) for r in net for pt in (r.get("playerTypes") or [])}),
    }
    result["playlist_summary"] = {
        "master": sum(1 for p in rec.playlists if p.get("master")),
        "media": len(media),
        "media_from_worker": sum(1 for p in media if p["session"] == "worker"),
        "media_with_ad_markers": sum(1 for p in media if p.get("has_ad")),
        "body_errors": sum(1 for p in rec.playlists if p.get("body_error")),
        "ad_marker_hits": hits, "info_marker_hits": info_hits,
        "markers_from": AD_MARKERS["source"],
        "first_ad_playlist_phase": next((p["phase"] for p in media if p.get("has_ad")), None),
    }
    states = rec.states
    end = result.get("page_health_end") or (states[-1] if states else {})
    switch = next((p for p in result["phases"] if p.get("phase") == "channel-switch"), {})
    result["summary"] = {
        "consent": [g for g in rec.gates if g.get("what") == "consent"] or "banner not seen",
        "mature_gate_clicks": sum(1 for g in rec.gates if g.get("what") == "mature-gate"),
        "ad_served_playlists": result["playlist_summary"]["media_with_ad_markers"],
        "ad_ui_visible_s": round(sum(p.get("ad_ui_visible_s") or 0 for p in result["phases"]), 1),
        "toasts_seen": sorted({t for p in result["phases"] for t in (p.get("toasts") or [])}),
        "video_advanced": {p["phase"]: p.get("video_advanced_s") for p in result["phases"]},
        "chat": {"present": end.get("chat"), "lines_added_total": sum(p.get("chat_lines_added") or 0 for p in result["phases"])},
        "channel_points": ("n/a (logged out)" if end.get("loggedOut") else bool(end.get("points"))),
        "navigation": switch.get("navigation_ok") if switch.get("navigation") else "not run",
        "problems_by_source": src,
    }
    result["network"] = net
    result["playlists"] = rec.playlists
    result["tas_console"] = rec.tas_console
    result["gates"] = rec.gates
    result["problems"] = rec.problems[:300]
    result["samples"] = rec.samples
    result["states"] = rec.states
    result["screenshots"] = rec.screens


def _cell(x):
    return str(x).replace("|", "/").replace("\n", " ")


def summarize_md(report):
    md = ["# Live test %s" % report["started"], "", "Channel: `%s`, minutes: %s, switch-to: %s, vod: %s" % (
        report["channel"], report["minutes"], report.get("switch_to"), report["vod"]), ""]
    for r in report["runs"]:
        md += ["## Run: %s" % r["label"], "", "Chrome: %s, viewport: %s" % (r.get("chrome"), json.dumps(r.get("viewport"))), ""]
        if r.get("error"):
            md += ["**Error:** `%s`" % r["error"], ""]
        s = r.get("summary", {})
        ns = r.get("network_summary", {})
        ps = r.get("playlist_summary", {})
        consent = s.get("consent")
        if isinstance(consent, list):
            consent = "; ".join("%s: %r clicked=%s gone=%s" % (c.get("phase"), c.get("button"), c.get("clicked"), c.get("banner_gone"))
                                for c in consent)
        src = s.get("problems_by_source", {})
        md += ["| Signal | Value |", "|---|---|",
               "| Cookie banner | %s |" % _cell(consent),
               "| Mature-gate clicks | %s |" % s.get("mature_gate_clicks"),
               "| Attached sessions | %s |" % _cell(json.dumps((r.get("attached_sessions") or {}).get("by_type"))),
               "| usher requests (from worker) | %s (%s) |" % (ns.get("usher"), ns.get("usher_from_worker")),
               "| m3u8 requests (from worker) | %s (%s) |" % (ns.get("m3u8"), ns.get("m3u8_from_worker")),
               "| Media playlists scanned (from worker) | %s (%s), body errors %s |" % (ps.get("media"), ps.get("media_from_worker"), ps.get("body_errors")),
               "| **Ad served: media playlists with ad markers** | **%s** (first in phase: %s) |" % (ps.get("media_with_ad_markers"), ps.get("first_ad_playlist_phase")),
               "| Ad marker hits | %s |" % _cell(json.dumps(ps.get("ad_marker_hits"))),
               "| Info markers (not ads) | %s |" % _cell(json.dumps(ps.get("info_marker_hits"))),
               "| playerType tokens requested | %s |" % _cell(", ".join(ns.get("gql_playerTypes_by_session") or []) or "none seen"),
               "| GQL PlaybackAccessToken requests | %s |" % ns.get("gql_token"),
               "| edge.ads requests (blocked) | %s (%s) |" % (ns.get("edge_ads"), ns.get("edge_ads_blocked")),
               "| **Twitch ad UI visible (s)** | **%s** |" % s.get("ad_ui_visible_s"),
               "| Extension toast seen | %s |" % _cell("; ".join(s.get("toasts_seen") or []) or "no"),
               "| Chat | present=%s, lines added %s |" % ((s.get("chat") or {}).get("present"), (s.get("chat") or {}).get("lines_added_total")),
               "| Channel points | %s |" % s.get("channel_points"),
               "| Navigation (channel switch) | %s |" % s.get("navigation"),
               "| **Errors attributed to the extension** | **%s** (worker-blob suspects: %s) |" % (src.get("extension", 0), src.get("extension?", 0)),
               "| Twitch's own errors / blocked-by-extension | %s / %s |" % (src.get("twitch", 0), src.get("blocked-by-extension", 0)),
               "| [TAS] console lines | %s |" % len(r.get("tas_console", [])),
               ""]
        md += ["| Phase | Video advanced (s) | OK | Paused / stalled samples | Ad UI (s) | Playlists (with ads) | Toasts | Chat + | Note |",
               "|---|---|---|---|---|---|---|---|---|"]
        for p in r.get("phases", []):
            note = p.get("note") or p.get("error") or ""
            md.append("| %s | %s | %s | %s / %s | %s | %s (%s) | %s | %s | %s |" % (
                p["phase"], p.get("video_advanced_s"), p.get("ok"), p.get("paused_samples"), p.get("stall_samples"),
                p.get("ad_ui_visible_s"), p.get("media_playlists"), p.get("media_playlists_with_ads"),
                len(p.get("toasts") or []), p.get("chat_lines_added"), _cell(note)))
        cpu = [x["chrome"]["cpu_percent"] for x in r.get("samples", []) if x.get("chrome")]
        heap = [x.get("JSHeapUsedSize_mb") for x in r.get("samples", []) if x.get("JSHeapUsedSize_mb") is not None]
        md.append("")
        if cpu:
            md.append("Chrome CPU%% avg %.1f / max %.1f" % (sum(cpu) / len(cpu), max(cpu)))
        if heap:
            md.append("JS heap MB first %.1f / last %.1f / max %.1f" % (heap[0], heap[-1], max(heap)))
        ext_errs = [p for p in r.get("problems", []) if p.get("source") in ("extension", "extension?")]
        if ext_errs:
            md += ["", "Extension errors (first 10):", ""]
            md += ["- [%s/%s/%s] %s" % (p.get("phase"), p.get("session_type"), p.get("source"), _cell(p.get("text"))[:200]) for p in ext_errs[:10]]
        end = r.get("page_health_end") or {}
        md += ["", "Page at end: url `%s`, chat=%s, chatLines=%s, points=%s, loggedOut=%s, viewport=%s" % (
            end.get("url"), end.get("chat"), end.get("chatLines"), end.get("points"), end.get("loggedOut"), end.get("viewport")), ""]
    md += ["Notes: fresh logged-out profile (channel points n/a; Twitch may serve fewer or different ads than to a "
           "logged-in viewer). 'Ad served' counts raw network responses (before the extension's worker rewrites them); "
           "'ad UI visible' is what the viewer saw.", ""]
    return md


def run_live(args):
    if args.base_url.startswith("https://www.twitch.tv"):
        print("LIVE MODE: this opens twitch.tv/%s and makes requests to Twitch." % args.live)
    else:
        print("Harness check against %s (not Twitch)." % args.base_url)
    outdir = results_dir("live-" + re.sub(r"[^a-zA-Z0-9_]", "", args.live))
    report = {"mode": "live", "channel": args.live, "minutes": args.minutes, "vod": bool(args.vod),
              "switch_to": args.switch_to, "ad_markers": AD_MARKERS, "started": now_iso(), "runs": []}
    report["runs"].append(run_scenario(args, True, outdir))
    if args.compare_without_extension:
        report["runs"].append(run_scenario(args, False, outdir))
    report["finished"] = now_iso()
    write_reports(outdir, report, summarize_md(report))
    print("Results:", os.path.relpath(outdir, ROOT))
    return 0 if all(not r.get("error") for r in report["runs"]) else 1


# --------------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--smoke", action="store_true", help="extension pages + service worker only, no Twitch traffic")
    mode.add_argument("--live", metavar="CHANNEL", help="watch a Twitch channel (needs approval: real Twitch traffic)")
    ap.add_argument("--minutes", type=float, default=5, help="live: minutes to watch the channel (default 5)")
    ap.add_argument("--vod", metavar="URL", help="live: also play this VOD URL")
    ap.add_argument("--switch-to", metavar="CHANNEL2", help="live: switch to this channel afterwards (in-app navigation)")
    ap.add_argument("--compare-without-extension", action="store_true", help="live: repeat the scenario without the extension")
    ap.add_argument("--debug-logging", action="store_true", help="live: turn on [TAS] debug logging in the extension")
    ap.add_argument("--headless", action="store_true", help="live: run headless (default: visible window)")
    ap.add_argument("--base-url", default="https://www.twitch.tv",
                    help="live: site base URL (default https://www.twitch.tv). Only change it to check the "
                         "harness itself offline, e.g. --base-url 'about:blank#'")
    ap.add_argument("--headed", action="store_true", help="smoke: show a window (default: headless=new)")
    args = ap.parse_args(argv)
    if not os.path.exists(CHROME):
        print("Google Chrome not found at", CHROME)
        return 2
    if args.live and not re.match(r"^[A-Za-z0-9_]{1,40}$", args.live):
        print("Channel name looks invalid:", args.live)
        return 2
    if args.switch_to and not re.match(r"^[A-Za-z0-9_]{1,40}$", args.switch_to):
        print("Channel name looks invalid:", args.switch_to)
        return 2
    return run_smoke(args) if args.smoke else run_live(args)


if __name__ == "__main__":
    sys.exit(main())
