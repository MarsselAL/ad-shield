#!/usr/bin/env python3
"""Watch a few YouTube videos in a throwaway headless Chrome, with and/or without AdBrake.

Usage:
    python3 -I tools/youtube_test.py                 # with the extension, then without
    python3 -I tools/youtube_test.py --only ext      # with the extension only
    python3 -I tools/youtube_test.py --only noext    # control run without the extension
    python3 -I tools/youtube_test.py --seconds 45 --video aqz-KE-bpKQ
    python3 -I tools/youtube_test.py --only ext --extension /path/to/copy --tag no-dnr   # another build
    python3 -I tools/youtube_test.py --no-nudge --seconds 20            # does the video start by itself?
    python3 -I tools/youtube_test.py --no-nudge --mode search           # in-page navigation: click a search result

Reuses the CDP pipe client from tools/live_test.py (fresh profile, quiet flags, extension loaded
with Extensions.loadUnpacked). The user agent is the normal Chrome one (no "Headless"). A
consent page or dialog is answered with "Reject all" (never accept). Per video it samples once a
second for --seconds: video currentTime / paused / muted, #movie_player.ad-showing, the skip
button, the anti-adblock element (ytd-enforcement-message-view-model) and the player's SSAP
debug flag; and it reports which ad keys (adPlacements, playerAds, adSlots) were
  - served: in the page HTML and in /youtubei/v1/player responses as they came off the network,
  - seen by the page: in window.ytInitialPlayerResponse and in movie_player.getPlayerResponse().
"played" means the content video's currentTime passed 3 s while no ad was showing.
Playback health of the main <video> (shared with live_test: stall events and ms, decoded / dropped
frames, resolution over time and time below 720p, paused ms and pause events not caused by the
harness) is sampled every 2 s per video; report.md gets a "Playback health" section per run and a
side-by-side table when both runs exist.
Results: results/<timestamp>-youtube/ (report.json, report.md, screenshots); results/ is not
committed. This sends real traffic to youtube.com. Headless profiles often get no ads at all,
so the run without the extension is the control.

Start state (every run): a probe added to each new document records the first timeupdate of the
main video with currentTime > 0.2 while no ad shows ("time to first frame", ms from the
navigation or the click) and every play / pause event. The table "Start state" gives, per
video, paused / getPlayerState() / currentTime at 3 s and 8 s, and "started paused" = at 8 s the
video is paused, no ad shows and the player state is -1 (unstarted), 2 (paused) or 5 (cued).
--no-nudge turns off the harness's click and play() at 5 s and 15 s, so a video that does not
start by itself stays paused. Both runs use --autoplay-policy=no-user-gesture-required
(live_test.LIVE_FLAGS), so Chrome's autoplay policy is the same with and without the extension.
--mode newtab opens the watch URL with window.open (user gesture) from the youtube.com page in a
new tab and measures there. --mode assign clicks an empty spot of the current youtube.com page and then loads the watch URL
with location.assign (full page load); with --chrome-autoplay this is the case where only the
click lets the new page autoplay. --mode search opens https://www.youtube.com/results?search_query=<query> and clicks the first
video result (a real mouse click, in-page navigation: get_watch, no page load); --video then
takes search queries.
"""
import argparse
import base64
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_test as lt  # noqa: E402

# Videos that get a pre-roll without the extension. (Despacito kJQP7kiw5Fk and Gangnam Style
# 9bZkp7q19f0 answered "Video unavailable ... restricted", error 151, on the 2026-11-21 test network.)
VIDEOS = [
    ("dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up"),
    ("XqZsoesa55w", "Baby Shark Dance"),
    ("MBRqu0YOH14", "Kurzgesagt - Optimistic Nihilism"),
]
SEARCHES = [("despacito", "search: despacito"), ("gangnam style", "search: gangnam style"),
            ("me at the zoo", "search: me at the zoo")]
AD_KEYS = ("adPlacements", "playerAds", "adSlots")
PLAYER_URL = re.compile(r"/youtubei/v1/player(\?|$)")

CONSENT_JS = r"""(() => {
  const want = /^(reject all|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto)$/i;
  const els = [...document.querySelectorAll('button, input[type=submit], [role=button]')];
  const b = els.filter(x => x.getClientRects().length).find(x => want.test((x.innerText || x.value || '').trim()) || /^reject/i.test(x.getAttribute('aria-label') || ''));
  if (!b) return null;
  b.click();
  return (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 60);
})()"""

SAMPLE_JS = r"""(() => {
  const keys = o => o && typeof o === 'object' ? %s.filter(k => o[k] !== undefined) : null;
  const p = document.getElementById('movie_player');
  let pr = null, ssap = null;
  try { pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null; } catch (e) {}
  try { const s = p && typeof p.getStatsForNerds === 'function' ? p.getStatsForNerds() : null; ssap = s && typeof s.debug_info === 'string' ? s.debug_info.slice(0, 40) : null; } catch (e) {}
  const d = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
  const v = document.querySelector('#movie_player video') || document.querySelector('video');
  const enf = document.querySelector('ytd-enforcement-message-view-model');
  const err = document.querySelector('.ytp-error');
  return {
    host: location.hostname, path: location.pathname + location.search, title: document.title,
    playerKeys: keys(pr), playerVideoId: pr && pr.videoDetails ? pr.videoDetails.videoId : null,
    initialKeys: keys(window.ytInitialPlayerResponse), initialTrap: !!(d && d.get),
    t: v ? v.currentTime : null, paused: v ? v.paused : null, muted: v ? v.muted : null,
    state: (() => { try { return p && typeof p.getPlayerState === 'function' ? p.getPlayerState() : null; } catch (e) { return null; } })(),
    vw: v ? v.videoWidth : null, vh: v ? v.videoHeight : null,
    duration: v ? v.duration : null, readyState: v ? v.readyState : null,
    adShowing: !!(p && p.classList.contains('ad-showing')), ssap: ssap,
    skipButton: [...document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')].some(b => b.getClientRects().length),
    enforcement: !!enf, enforcementVisible: !!(enf && enf.getClientRects().length),
    adSlotRenderers: document.querySelectorAll('ytd-ad-slot-renderer').length,
    error: err && err.offsetParent ? err.innerText.slice(0, 200) : null
  };
})()""" % json.dumps(list(AD_KEYS))

PLAY_JS = r"""(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('#movie_player video') || document.querySelector('video');
  try { if (p && typeof p.playVideo === 'function') p.playVideo(); } catch (e) {}
  if (v && v.paused) { const r = v.play(); if (r && r.catch) r.catch(() => {}); }
  return !!v;
})()"""

PLAYER_BOX_JS = r"""(() => {
  const v = document.querySelector('#movie_player video');
  if (!v) return null;
  const r = v.getBoundingClientRect();
  return r.width ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null;
})()"""

# Added to every new document (main world): first frame of the content video and play / pause events.
PROBE_JS = r"""(() => {
  if (window.__asProbe) return;
  const P = window.__asProbe = { first: {}, events: [] };
  const vid = () => { try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; } };
  const main = v => v && v.tagName === 'VIDEO' && v.closest && v.closest('#movie_player');
  const ad = () => { const p = document.getElementById('movie_player'); return !!(p && p.classList.contains('ad-showing')); };
  document.addEventListener('timeupdate', e => {
    const v = e.target, id = vid();
    if (!main(v) || ad() || !(v.currentTime > 0.2) || !id || P.first[id]) return;
    P.first[id] = { at: Date.now(), ct: v.currentTime, w: v.videoWidth, h: v.videoHeight };
  }, true);
  for (const n of ['play', 'playing', 'pause']) document.addEventListener(n, e => {
    if (main(e.target) && P.events.length < 300)
      P.events.push({ n: n, at: Date.now(), vid: vid(), ct: Math.round(e.target.currentTime * 100) / 100, ad: ad() });
  }, true);
})()"""

PROBE_READ_JS = "window.__asProbe ? JSON.parse(JSON.stringify(window.__asProbe)) : null"

FIRST_RESULT_JS = r"""(() => {
  const a = [...document.querySelectorAll('ytd-video-renderer a#thumbnail[href*="/watch?v="]')].find(x => x.getClientRects().length);
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  const r = a.getBoundingClientRect();
  return { href: a.getAttribute('href'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()"""

STARTED_PAUSED_STATES = (-1, 2, 5)

HEALTH_JS = lt.health_js("document.querySelector('#movie_player video') || document.querySelector('video')")

SW_SCRIPTS_JS = "chrome.scripting.getRegisteredContentScripts().then(s => s.map(x => x.id))"


def keys_in(text):
    return [k for k in AD_KEYS if ('"%s"' % k) in (text or "")]


def screenshot(cdp, sid, path):
    try:
        shot = cdp.send("Page.captureScreenshot", {"format": "png"}, session=sid, timeout=20)
        with open(path, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        return os.path.basename(path)
    except lt.CDPError:
        return None


class NetLog:
    """Remembers the main document and /youtubei/v1/player responses of one page session."""

    def __init__(self, cdp, sid):
        self.cdp, self.sid = cdp, sid
        self.docs, self.players, self.exceptions = [], [], []
        self.consented = None  # text of the consent button clicked in this profile, once

    def pump(self):
        for ev in self.cdp.drain(0):
            if ev.get("sessionId") != self.sid:
                continue
            m, p = ev.get("method"), ev.get("params", {})
            if m == "Network.responseReceived":
                url = p.get("response", {}).get("url", "")
                if p.get("type") == "Document" and "youtube.com/watch" in url:
                    self.docs.append(p["requestId"])
                elif PLAYER_URL.search(url):
                    self.players.append(p["requestId"])
            elif m == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                self.exceptions.append((d.get("exception", {}).get("description") or d.get("text") or "")[:200])

    def body(self, rid):
        try:
            r = self.cdp.send("Network.getResponseBody", {"requestId": rid}, session=self.sid, timeout=20)
        except lt.CDPError:
            return None
        b = r.get("body", "")
        return base64.b64decode(b).decode("utf-8", "replace") if r.get("base64Encoded") else b

    def served(self):
        docs = [keys_in(self.body(r)) for r in self.docs[-1:]]
        players = [keys_in(self.body(r)) for r in self.players]
        return {"htmlAdKeys": docs[0] if docs else None, "playerResponses": len(self.players),
                "playerResponsesWithAdKeys": sum(1 for k in players if k), "playerResponseAdKeys": sorted({x for k in players for x in k})}


def click_at(cdp, sid, x, y):
    for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
        cdp.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left",
                                              "clickCount": 0 if typ == "mouseMoved" else 1}, session=sid)


def open_from_search(cdp, sid, net, query, hover=0.0):
    """Search page, then a real click on the first video result. Returns (video id, click time)."""
    url = "https://www.youtube.com/results?search_query=" + query.replace(" ", "+")
    cdp.send("Page.navigate", {"url": url}, session=sid)
    for _ in range(20):
        time.sleep(1)
        net.pump()
        try:
            host = cdp.evaluate(sid, "location.hostname")
            if host.startswith("consent.") or not net.consented:
                clicked = cdp.evaluate(sid, CONSENT_JS)
                if clicked:
                    net.consented = clicked
                    time.sleep(4)
                    if "consent" in cdp.evaluate(sid, "location.hostname"):
                        cdp.send("Page.navigate", {"url": url}, session=sid)
                    continue
            hit = cdp.evaluate(sid, FIRST_RESULT_JS)
        except lt.CDPError:
            continue
        if hit:
            time.sleep(1.5)  # let the result list settle after scrollIntoView
            hit = cdp.evaluate(sid, FIRST_RESULT_JS) or hit
            m = re.search(r"[?&]v=([\w-]{11})", hit["href"])
            if hover:  # rest the mouse on the thumbnail first: the search page starts its inline (muted) preview
                cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": hit["x"], "y": hit["y"]}, session=sid)
                time.sleep(hover)
            t0 = time.time()
            click_at(cdp, sid, hit["x"], hit["y"])
            return (m.group(1) if m else None), t0, hit["href"]
    return None, time.time(), None


def warm_up(cdp, sid, net):
    """Answer the consent page / dialog once on the home page, so that the first measured video
    is not the one whose page reloads after "Reject all" (a fresh profile in the EU)."""
    cdp.send("Page.navigate", {"url": "https://www.youtube.com/"}, session=sid)
    for _ in range(15):
        time.sleep(1)
        net.pump()
        try:
            clicked = cdp.evaluate(sid, CONSENT_JS)
        except lt.CDPError:
            continue
        if clicked:
            net.consented = clicked
            time.sleep(5)
            break
    else:
        net.consented = net.consented or "none shown"
    return net.consented


def at_time(samples, sec):
    s = next((x for x in samples if x.get("el") is not None and x["el"] >= sec and "host" in x), None)
    if not s:
        return None
    return {"el": s["el"], "paused": s.get("paused"), "state": s.get("state"),
            "t": round(s["t"], 2) if isinstance(s.get("t"), (int, float)) else s.get("t"),
            "ad": s.get("adShowing"), "res": "%sx%s" % (s.get("vw"), s.get("vh")), "path": (s.get("path") or "")[:60]}


def start_summary(samples, probe, video_id, t0):
    a3, a8 = at_time(samples, 3), at_time(samples, 8)
    first = (probe or {}).get("first", {}).get(video_id) if video_id else None
    ev = [dict(e, el=round(e["at"] / 1000.0 - t0, 2)) for e in (probe or {}).get("events", [])
          if e.get("vid") == video_id and e["at"] / 1000.0 >= t0 - 1]
    played = next((x for x in samples if "host" in x and not x.get("adShowing") and isinstance(x.get("t"), (int, float))
                   and x["t"] > 0.2), None)
    started_paused = bool(a8 and a8["paused"] and not a8["ad"] and a8["state"] in STARTED_PAUSED_STATES)
    return {"ttffMs": round(first["at"] - t0 * 1000) if first else None, "firstFrame": first,
            "firstPlayingSampleS": played["el"] if played else None, "at3": a3, "at8": a8, "startedPaused": started_paused,
            "contentPauses": [e for e in ev if e["n"] == "pause" and not e["ad"]], "events": ev[:40]}


def watch(cdp, sid, net, video_id, label, seconds, outdir, tag, nudge=True, mode="direct", hover=0.0):
    net.docs, net.players, net.exceptions = [], [], []
    query, href, tab_tid = None, None, None
    if mode == "search":
        query = video_id
        video_id, t0, href = open_from_search(cdp, sid, net, query, hover)
        url = "https://www.youtube.com" + (href or "")
    elif mode == "assign":
        # A user click on a youtube.com page, then a full same-origin page load started by the page
        # (location.assign): Chrome lets the new page autoplay because of that click
        # (sticky user activation across a same-origin navigation), without media engagement.
        url = "https://www.youtube.com/watch?v=" + video_id
        if not cdp.evaluate(sid, "location.hostname") == "www.youtube.com":
            cdp.send("Page.navigate", {"url": "https://www.youtube.com/"}, session=sid)
            time.sleep(4)
        click_at(cdp, sid, 8, 700)  # left margin of the page: no link, no player
        time.sleep(0.3)
        t0 = time.time()
        cdp.evaluate(sid, "location.assign(%s), true" % json.dumps(url))
    elif mode == "newtab":
        # window.open from a youtube.com page with a user gesture (like a ctrl / middle click on a
        # video link, then switching to it): a new tab with a full page load.
        url = "https://www.youtube.com/watch?v=" + video_id
        if not cdp.evaluate(sid, "location.hostname") == "www.youtube.com":
            cdp.send("Page.navigate", {"url": "https://www.youtube.com/"}, session=sid)
            time.sleep(4)
        before = {t["targetId"] for t in cdp.send("Target.getTargets")["targetInfos"]}
        t0 = time.time()
        cdp.send("Runtime.evaluate", {"expression": "window.open(%s, '_blank'), true" % json.dumps(url), "userGesture": True},
                 session=sid)
        new = None
        for _ in range(50):
            new = next((t for t in cdp.send("Target.getTargets")["targetInfos"]
                        if t["type"] == "page" and t["targetId"] not in before), None)
            if new:
                break
            time.sleep(0.1)
        if new:
            tab_tid = new["targetId"]
            sid = lt.attach(cdp, tab_tid)
            for m in ("Runtime.enable", "Page.enable"):
                cdp.send(m, session=sid)
            cdp.send("Network.enable", lt.NET_ENABLE, session=sid)
            cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": PROBE_JS}, session=sid)
            cdp.evaluate(sid, PROBE_JS)  # the document may already be there
            consented, net = net.consented, NetLog(cdp, sid)
            net.consented = consented
    else:
        url = "https://www.youtube.com/watch?v=" + video_id
        t0 = time.time()
        cdp.send("Page.navigate", {"url": url}, session=sid)
    consent = None
    samples = []
    for _ in range(12):  # up to ~12 s for the watch page (or a consent page) to come up
        time.sleep(1)
        net.pump()
        try:
            st = cdp.evaluate(sid, SAMPLE_JS)
        except lt.CDPError:
            continue
        st["i"], st["el"] = -1, round(time.time() - t0, 2)
        samples.append(st)
        if st["host"].startswith("consent.") or not net.consented:
            lt.health_mark(cdp, sid)
            clicked = cdp.evaluate(sid, CONSENT_JS)
            if clicked:
                consent = net.consented = clicked
                time.sleep(4)
                if not cdp.evaluate(sid, "location.hostname").endswith("youtube.com") or "consent" in cdp.evaluate(sid, "location.hostname"):
                    cdp.send("Page.navigate", {"url": url}, session=sid)
                continue
        if st["host"] == "www.youtube.com" and st["t"] is not None and st["path"].startswith("/watch"):
            break
    shots, nudged, health = [], False, []
    first_ad_shot = False
    for i in range(seconds):
        time.sleep(1)
        net.pump()
        try:
            s = cdp.evaluate(sid, SAMPLE_JS)
        except lt.CDPError as e:
            s = {"error": str(e)}
        s["i"], s["el"] = i, round(time.time() - t0, 2)
        samples.append(s)
        if i % 2 == 0:
            health.append(lt.health_sample(cdp, sid, HEALTH_JS, video_id))
        if i < 15 and not net.consented:
            # The in-page consent dialog can appear after the player; it pauses the video.
            lt.health_mark(cdp, sid)
            clicked = cdp.evaluate(sid, CONSENT_JS)
            if clicked:
                consent = net.consented = clicked
                s["consentClicked"] = clicked
        if nudge and i in (5, 15) and s.get("paused") and not s.get("adShowing"):
            # Autoplay stalled (headless / no gesture): one real click on the player, then play().
            lt.health_mark(cdp, sid, 5000)  # a click on the player toggles play / pause
            box = cdp.evaluate(sid, PLAYER_BOX_JS)
            if box:
                click_at(cdp, sid, box[0], box[1])
                time.sleep(1)
            if cdp.evaluate(sid, "(document.querySelector('#movie_player video') || {}).paused === true"):
                cdp.evaluate(sid, PLAY_JS)
            nudged = True
        if s.get("adShowing") and not first_ad_shot:
            first_ad_shot = True
            shots.append(screenshot(cdp, sid, os.path.join(outdir, "%s-%s-ad.png" % (tag, video_id))))
    shots.append(screenshot(cdp, sid, os.path.join(outdir, "%s-%s-end.png" % (tag, video_id))))
    health.append(lt.health_sample(cdp, sid, HEALTH_JS, video_id))
    net.pump()
    try:
        probe = cdp.evaluate(sid, PROBE_READ_JS)
    except lt.CDPError:
        probe = None
    content_t = [s["t"] for s in samples if s.get("t") is not None and not s.get("adShowing")]
    last = next((s for s in reversed(samples) if "host" in s), {})
    if tab_tid:
        try:
            cdp.send("Target.closeTarget", {"targetId": tab_tid})
        except lt.CDPError:
            pass
    return {
        "video": video_id, "label": label, "mode": mode, "query": query, "url": url,
        "consent": consent, "nudgedPlay": bool(nudged), "nudge": nudge,
        "start": start_summary(samples, probe, video_id, t0),
        "played": bool(content_t) and max(content_t) > 3,
        "maxContentTime": round(max(content_t), 1) if content_t else None,
        "adShowingSeconds": sum(1 for s in samples if s.get("adShowing")),
        "ssapSeen": any((s.get("ssap") or "").startswith("SSAP") for s in samples),
        "skipButtonSeen": any(s.get("skipButton") for s in samples),
        "enforcementSeen": any(s.get("enforcement") for s in samples),
        "enforcementVisible": any(s.get("enforcementVisible") for s in samples),
        "playerError": next((s["error"] for s in samples if s.get("error")), None),
        "pageSaw": {"initialKeys": last.get("initialKeys"), "playerKeys": last.get("playerKeys"),
                    "initialTrap": last.get("initialTrap"), "playerVideoId": last.get("playerVideoId")},
        "served": net.served(),
        "adSlotRenderersInDom": last.get("adSlotRenderers"),
        "pageExceptions": net.exceptions[:10], "pageExceptionCount": len(net.exceptions),
        "title": last.get("title"), "screenshots": [s for s in shots if s],
        "health": lt.health_summary(health),
        "healthSamples": health,
        "samples": samples,
    }


def run_once(with_extension, videos, seconds, outdir, extension=None, nudge=True, mode="direct", chrome_autoplay=False,
             hover=0.0, headed=False):
    flags = [f for f in lt.LIVE_FLAGS if not (chrome_autoplay and f.startswith("--autoplay-policy="))]
    cdp = lt.PipeCDP(flags, headless=not headed)
    tag = "ext" if with_extension else "noext"
    try:
        ua = cdp.send("Browser.getVersion").get("userAgent", "").replace("HeadlessChrome", "Chrome")
        ext_id, registered = None, None
        if with_extension:
            ext_id = lt.load_extension(cdp, extension)
            sw = lt.find_sw_target(cdp, ext_id)
            if sw:
                sw_sid = lt.attach(cdp, sw["targetId"])
                for _ in range(40):
                    registered = cdp.evaluate(sw_sid, SW_SCRIPTS_JS)
                    if registered and "as-scriptlets" in registered:
                        break
                    time.sleep(0.25)
            time.sleep(1)
        tid, sid = lt.open_page(cdp, "about:blank")
        for m in ("Network.enable",):
            cdp.send(m, lt.NET_ENABLE, session=sid)
        cdp.send("Emulation.setUserAgentOverride", {"userAgent": ua, "acceptLanguage": "en-US,en"}, session=sid)
        cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True}, session=sid)
        cdp.send("Page.bringToFront", session=sid)
        cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": PROBE_JS}, session=sid)
        net = NetLog(cdp, sid)
        print("  %s consent: %s" % (tag, warm_up(cdp, sid, net)), flush=True)
        results = []
        for vid, label in videos:
            r = watch(cdp, sid, net, vid, label, seconds, outdir, tag, nudge=nudge, mode=mode, hover=hover)
            st = r["start"]
            print("  %s %s start: ttff=%sms startedPaused=%s at3=%s at8=%s contentPauses=%d" % (
                tag, r["video"], st["ttffMs"], st["startedPaused"], st["at3"], st["at8"], len(st["contentPauses"])), flush=True)
            print("  %s %s: played=%s adShowing=%ss skip=%s ssap=%s wall=%s | page saw initial=%s player=%s | served html=%s player=%d/%d %s" % (
                tag, vid, r["played"], r["adShowingSeconds"], r["skipButtonSeen"], r["ssapSeen"], r["enforcementSeen"],
                r["pageSaw"]["initialKeys"], r["pageSaw"]["playerKeys"], r["served"]["htmlAdKeys"],
                r["served"]["playerResponsesWithAdKeys"], r["served"]["playerResponses"], r["served"]["playerResponseAdKeys"]), flush=True)
            results.append(r)
        all_health = [h for r in results for h in r["healthSamples"]]  # grouped by video id
        return {"withExtension": with_extension, "extensionId": ext_id, "nudge": nudge, "mode": mode,
                "autoplayPolicy": "chrome default" if chrome_autoplay else "no-user-gesture-required", "extensionPath": extension or lt.ROOT if with_extension else None,
                "registeredScripts": registered,
                "userAgent": ua, "health": lt.health_summary(all_health), "videos": results}
    finally:
        cdp.close()


def write_md(outdir, runs, seconds):
    lines = ["# YouTube run %s" % os.path.basename(outdir), "",
             "Each video watched for %d s in a fresh headless profile. Ad keys: %s." % (seconds, ", ".join(AD_KEYS)), ""]
    for run in runs:
        lines += ["## %s" % ("With AdBrake" if run["withExtension"] else "Without extension (control)"), "",
                  "Extension: %s" % (run.get("extensionPath") or "-"), "",
                  "Registered scripts: %s" % (run.get("registeredScripts") or "-"), "",
                  "| Video | Played | Max content t | ad-showing s | Skip btn | SSAP | Wall | Page saw (initial / player) | Served (HTML / player responses) | Page exceptions |",
                  "|---|---|---|---|---|---|---|---|---|---|"]
        for v in run["videos"]:
            lines.append("| %s | %s | %s | %d | %s | %s | %s | %s / %s | %s / %d of %d %s | %d |" % (
                v["video"], v["played"], v["maxContentTime"], v["adShowingSeconds"], v["skipButtonSeen"], v["ssapSeen"],
                v["enforcementSeen"], v["pageSaw"]["initialKeys"], v["pageSaw"]["playerKeys"], v["served"]["htmlAdKeys"],
                v["served"]["playerResponsesWithAdKeys"], v["served"]["playerResponses"], v["served"]["playerResponseAdKeys"],
                v["pageExceptionCount"]))
        lines += ["", "### Start state (%s, mode %s, harness nudges %s, autoplay policy %s)" % (
            "with AdBrake" if run["withExtension"] else "without extension", run.get("mode"), "on" if run.get("nudge") else "off",
            run.get("autoplayPolicy")), "",
                  "| Video | Time to first frame ms | Started paused | 3 s: paused / state / t / res | 8 s: paused / state / t / res | Content pause events |",
                  "|---|---|---|---|---|---|"]
        for v in run["videos"]:
            st = v.get("start") or {}
            cell = lambda a: "%s / %s / %s / %s" % (a["paused"], a["state"], a["t"], a["res"]) if a else "-"
            lines.append("| %s | %s | %s | %s | %s | %d |" % (v["video"], st.get("ttffMs"), st.get("startedPaused"),
                                                            cell(st.get("at3")), cell(st.get("at8")), len(st.get("contentPauses") or [])))
        lines += ["", "### Playback health (%s)" % ("with AdBrake" if run["withExtension"] else "without extension"), ""]
        lines += lt.HEALTH_MD_HEAD
        for v in run["videos"]:
            lines.append(lt.health_md_row(v["video"], v.get("health")))
        lines.append(lt.health_md_row("**all videos**", run.get("health")))
        lines.append("")
    if len(runs) >= 2:
        lines += ["## Playback health: with vs without the extension", "",
                  "Totals over all videos (separate fresh profiles, one after the other).", ""]
        lines += lt.health_compare_md([("with AdBrake" if r["withExtension"] else "without extension", r.get("health"))
                                       for r in runs])
        lines += ["", "| Video | " + " | ".join("%s: stall events / ms / dropped %% / below 720p %% / pauses" % (
            "ext" if r["withExtension"] else "noext") for r in runs) + " |", "|---" * (len(runs) + 1) + "|"]
        for vid in [v["video"] for v in runs[0]["videos"]]:
            cells = []
            for r in runs:
                h = next((v.get("health") for v in r["videos"] if v["video"] == vid), None) or {}
                cells.append("%s / %s / %s / %s / %s" % (h.get("stall_events"), h.get("stall_ms"), h.get("dropped_pct"),
                                                         h.get("below_720p_pct"), h.get("pause_events")))
            lines.append("| %s | %s |" % (vid, " | ".join(cells)))
        lines.append("")
    lines += ["Playback health: stall ms = time the playhead did not advance while not paused (ad playback "
              "included); frames from getVideoPlaybackQuality(); pauses exclude the harness's own clicks / play().", ""]
    with open(os.path.join(outdir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=["ext", "noext"])
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--video", action="append", help="video id (repeatable); default: three popular videos")
    ap.add_argument("--extension", metavar="DIR", help="unpacked extension folder to load (default: this checkout)")
    ap.add_argument("--tag", help="suffix for the results folder name, e.g. the variant under test")
    ap.add_argument("--no-nudge", action="store_true", help="no harness click / play() when the video sits paused")
    ap.add_argument("--headed", action="store_true", help="show the Chrome window (default: headless=new)")
    ap.add_argument("--hover", type=float, default=0.0, metavar="S",
                    help="--mode search: rest the mouse on the result for S seconds before the click (inline preview)")
    ap.add_argument("--chrome-autoplay", action="store_true",
                    help="leave Chrome's own autoplay policy on (no --autoplay-policy flag): a fresh profile has no "
                         "media engagement, so autoplay with sound needs a user gesture, as for a new user")
    ap.add_argument("--mode", choices=["direct", "search", "assign", "newtab"], default="direct",
                    help="direct: load the watch URL; search: click the first search result (in-page navigation); "
                         "assign: a click on the current youtube.com page, then location.assign(watch URL) (a full "
                         "same-origin load after a user gesture); newtab: window.open(watch URL) with a user "
                         "gesture from the current youtube.com page (new tab, full load)")
    args = ap.parse_args(argv)
    if args.extension and not os.path.isfile(os.path.join(args.extension, "manifest.json")):
        ap.error("--extension: no manifest.json in %s" % args.extension)
    videos = [(v, v) for v in args.video] if args.video else (SEARCHES if args.mode == "search" else VIDEOS)
    outdir = lt.results_dir("youtube" + ("-" + re.sub(r"[^A-Za-z0-9_.-]", "_", args.tag) if args.tag else ""))
    runs = []
    for with_ext in (True, False):
        if args.only and args.only != ("ext" if with_ext else "noext"):
            continue
        print("ext" if with_ext else "noext", flush=True)
        runs.append(run_once(with_ext, videos, args.seconds, outdir, os.path.abspath(args.extension) if args.extension else None,
                             nudge=not args.no_nudge, mode=args.mode, chrome_autoplay=args.chrome_autoplay, hover=args.hover, headed=args.headed))
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(runs, f, indent=1)
    write_md(outdir, runs, args.seconds)
    print(outdir)


if __name__ == "__main__":
    main()
