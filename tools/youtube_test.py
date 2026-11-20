#!/usr/bin/env python3
"""Watch a few YouTube videos in a throwaway headless Chrome, with and/or without Ad Shield.

Usage:
    python3 -I tools/youtube_test.py                 # with the extension, then without
    python3 -I tools/youtube_test.py --only ext      # with the extension only
    python3 -I tools/youtube_test.py --only noext    # control run without the extension
    python3 -I tools/youtube_test.py --seconds 45 --video kJQP7kiw5Fk
    python3 -I tools/youtube_test.py --only ext --extension /path/to/copy --tag no-dnr   # another build

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

VIDEOS = [
    ("jNQXAC9IVRw", "Me at the zoo (19 s)"),
    ("kJQP7kiw5Fk", "Luis Fonsi - Despacito (music video)"),
    ("9bZkp7q19f0", "PSY - Gangnam Style (music video)"),
]
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


def watch(cdp, sid, net, video_id, label, seconds, outdir, tag):
    url = "https://www.youtube.com/watch?v=" + video_id
    net.docs, net.players, net.exceptions = [], [], []
    cdp.send("Page.navigate", {"url": url}, session=sid)
    consent = None
    for _ in range(12):  # up to ~12 s for the watch page (or a consent page) to come up
        time.sleep(1)
        net.pump()
        try:
            st = cdp.evaluate(sid, SAMPLE_JS)
        except lt.CDPError:
            continue
        if st["host"].startswith("consent.") or not net.consented:
            lt.health_mark(cdp, sid)
            clicked = cdp.evaluate(sid, CONSENT_JS)
            if clicked:
                consent = net.consented = clicked
                time.sleep(4)
                if not cdp.evaluate(sid, "location.hostname").endswith("youtube.com") or "consent" in cdp.evaluate(sid, "location.hostname"):
                    cdp.send("Page.navigate", {"url": url}, session=sid)
                continue
        if st["host"] == "www.youtube.com" and st["t"] is not None:
            break
    samples, shots, nudged, health = [], [], False, []
    first_ad_shot = False
    for i in range(seconds):
        time.sleep(1)
        net.pump()
        try:
            s = cdp.evaluate(sid, SAMPLE_JS)
        except lt.CDPError as e:
            s = {"error": str(e)}
        s["i"] = i
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
        if i in (5, 15) and s.get("paused") and not s.get("adShowing"):
            # Autoplay stalled (headless / no gesture): one real click on the player, then play().
            lt.health_mark(cdp, sid, 5000)  # a click on the player toggles play / pause
            box = cdp.evaluate(sid, PLAYER_BOX_JS)
            if box:
                for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
                    cdp.send("Input.dispatchMouseEvent", {"type": typ, "x": box[0], "y": box[1], "button": "left",
                                                          "clickCount": 0 if typ == "mouseMoved" else 1}, session=sid)
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
    content_t = [s["t"] for s in samples if s.get("t") is not None and not s.get("adShowing")]
    last = next((s for s in reversed(samples) if "host" in s), {})
    return {
        "video": video_id, "label": label, "consent": consent, "nudgedPlay": bool(nudged),
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


def run_once(with_extension, videos, seconds, outdir, extension=None):
    cdp = lt.PipeCDP(lt.LIVE_FLAGS, headless=True)
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
        net = NetLog(cdp, sid)
        results = []
        for vid, label in videos:
            r = watch(cdp, sid, net, vid, label, seconds, outdir, tag)
            print("  %s %s: played=%s adShowing=%ss skip=%s ssap=%s wall=%s | page saw initial=%s player=%s | served html=%s player=%d/%d %s" % (
                tag, vid, r["played"], r["adShowingSeconds"], r["skipButtonSeen"], r["ssapSeen"], r["enforcementSeen"],
                r["pageSaw"]["initialKeys"], r["pageSaw"]["playerKeys"], r["served"]["htmlAdKeys"],
                r["served"]["playerResponsesWithAdKeys"], r["served"]["playerResponses"], r["served"]["playerResponseAdKeys"]), flush=True)
            results.append(r)
        all_health = [h for r in results for h in r["healthSamples"]]  # grouped by video id
        return {"withExtension": with_extension, "extensionId": ext_id, "extensionPath": extension or lt.ROOT if with_extension else None,
                "registeredScripts": registered,
                "userAgent": ua, "health": lt.health_summary(all_health), "videos": results}
    finally:
        cdp.close()


def write_md(outdir, runs, seconds):
    lines = ["# YouTube run %s" % os.path.basename(outdir), "",
             "Each video watched for %d s in a fresh headless profile. Ad keys: %s." % (seconds, ", ".join(AD_KEYS)), ""]
    for run in runs:
        lines += ["## %s" % ("With Ad Shield" if run["withExtension"] else "Without extension (control)"), "",
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
        lines += ["", "### Playback health (%s)" % ("with Ad Shield" if run["withExtension"] else "without extension"), ""]
        lines += lt.HEALTH_MD_HEAD
        for v in run["videos"]:
            lines.append(lt.health_md_row(v["video"], v.get("health")))
        lines.append(lt.health_md_row("**all videos**", run.get("health")))
        lines.append("")
    if len(runs) >= 2:
        lines += ["## Playback health: with vs without the extension", "",
                  "Totals over all videos (separate fresh profiles, one after the other).", ""]
        lines += lt.health_compare_md([("with Ad Shield" if r["withExtension"] else "without extension", r.get("health"))
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
    args = ap.parse_args(argv)
    if args.extension and not os.path.isfile(os.path.join(args.extension, "manifest.json")):
        ap.error("--extension: no manifest.json in %s" % args.extension)
    videos = [(v, v) for v in args.video] if args.video else VIDEOS
    outdir = lt.results_dir("youtube" + ("-" + re.sub(r"[^A-Za-z0-9_.-]", "_", args.tag) if args.tag else ""))
    runs = []
    for with_ext in (True, False):
        if args.only and args.only != ("ext" if with_ext else "noext"):
            continue
        print("ext" if with_ext else "noext", flush=True)
        runs.append(run_once(with_ext, videos, args.seconds, outdir, os.path.abspath(args.extension) if args.extension else None))
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(runs, f, indent=1)
    write_md(outdir, runs, args.seconds)
    print(outdir)


if __name__ == "__main__":
    main()
