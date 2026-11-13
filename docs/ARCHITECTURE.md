# Architecture

Twitch Ad Shield is plain JavaScript loaded as classic scripts; there is no bundler. Every file
attaches what it exports to one namespace object, `__TAS__`, on its global (window, isolated
world, service worker, or the jsc test shell). In the page's MAIN world, `page.js` copies the
references it needs and deletes the namespace again, so the page's global object is left
almost untouched.

## Modules

| File | World / context | Role |
|---|---|---|
| `src/config.js` | all | **Single source of truth** for everything Twitch can change (markers, ignored DATERANGE classes, ad segment patterns, persisted query hash, Client-ID, backup order, usher URL patterns, timeouts, limits, selectors). JSON-serialisable and deep-frozen. Each value is commented with its source. |
| `src/shared/settings.js` | all | Defaults, `normalize` (never throws), `validate`, playerType list validation. |
| `src/shared/logger.js` | all, inlined in worker | `[TAS]` logger; debug/info only when debug is on. |
| `src/shared/frame.js` | MAIN, ISOLATED | Run in top frame and Twitch player sub-frames only; skip clips. |
| `src/shared/stats.js` | background, bridge, popup | Event → counter mapping, badge text, event and toast texts, popup status logic. |
| `src/core/m3u8.js` | MAIN, inlined in worker, tests | Pure HLS functions: `hasAds`, `isMidroll`, `classifyDateranges`, `stripAds`, `parseMedia`, `resequence`, `parseMaster`, `pickVariant`, `filterMasterCodecs`, `buildUsherUrl`, `matchUsher`, `isAdSegmentUrl`. No DOM, no `URL`, no `chrome.*`. |
| `src/core/gql.js` | MAIN, tests | PlaybackAccessToken body/headers, header capture, playerType rewrite, token parsing. |
| `src/core/processor.js` | inlined in worker, tests | The backup / strip state machine with injected `fetchText`, `getToken`, `now`, `emit`, `setTimeout`: poll deadline, single-flight search, ordered answers, renumbering. |
| `src/worker/worker-main.js` | inlined in worker | Replaces the worker's `fetch`, talks to the page, serves blank ad-segment answers. |
| `src/core/worker-source.js` | MAIN, tests | Builds the replacement worker source from the factories' `toString()` plus JSON data plus Twitch's original source. |
| `src/page/recovery.js` | MAIN | Stall watch (user-intent tracking, play/seek/nudge, muted-play retry), React-fiber player reload, reload rate limit, localStorage preservation. |
| `src/page/page.js` | MAIN | fetch hook, Worker hook, token requests, event relay. |
| `src/content/bridge.js` | ISOLATED | Settings to the page, events to the background, toast, popup status answers. |
| `src/content/cosmetic.js` | ISOLATED | Hides/mutes/pauses standalone ad `<video>` elements. |
| `src/background/service-worker.js` | service worker | Settings defaults, script registration, DNR rulesets, stats, badge. |
| `src/popup/*`, `src/options/*`, `src/ui/common.css` | extension pages | UI. Light/dark via `prefers-color-scheme`, no external resources. |
| `rules/client_ads.json`, `rules/trackers.json` | DNR | Static block rules, toggled with `updateEnabledRulesets`. |

### Inlining into the worker

The video worker is created by Twitch from a blob URL; content scripts cannot run there. The
factories `tasM3u8Factory`, `tasProcessorFactory`, `tasLoggerFactory` and `tasWorkerMain` are
written without any outer-scope references, so their `Function.prototype.toString()` output is
a complete program. `worker-source.js` produces:

```
["use strict";]                       (only if Twitch's worker starts with it)
/* __TAS_WORKER__ */                  (marker: never wrap twice)
;(function () {
  var cfg = {...}; var boot = {settings, degraded};
  var M = (factory)(); var createProcessor = (factory)(); var createLogger = (factory)();
  (workerMain)(self, cfg, boot, M, createProcessor, createLogger);   // in try/catch
})();
<Twitch's original worker source>
```

No `eval`, no remote code, no `web_accessible_resources`. `tests/syntax.test.js` checks the
factories are self-contained and `tests/worker.test.js` compiles and runs the generated source
against a fake worker global; the smoke test runs it in a real Chrome worker.

## Data flow

1. **Install / startup** – the service worker normalises settings and registers two content
   scripts with `chrome.scripting.registerContentScripts` (`persistAcrossSessions: true`,
   `runAt: document_start`, `allFrames: true`, matches `https://*.twitch.tv/*`, excludes
   `https://clips.twitch.tv/*`): `tas-page-main` (MAIN world) and `tas-bridge-isolated`
   (ISOLATED world). On update it re-registers, so new files apply automatically. Turning the
   extension off unregisters both and disables both rulesets.
2. **Page load** – `page.js` runs before Twitch's code. Defaults are available synchronously.
   It hooks `fetch` and replaces `Worker` with a subclass, then says `hello`. The bridge reads
   `chrome.storage.local` and sends the settings as a `tas:to-page` CustomEvent (payload is a
   JSON string). The bridge also pings, so the handshake works whichever script runs first.
   Settings arrive milliseconds after start, long before the player creates its worker;
   workers that already exist get them by message.
3. **Page token request** – the fetch hook copies `Client-ID`, `Device-ID`/`X-Device-Id`,
   `Authorization`, `Client-Integrity`, `Client-Version`, `Client-Session-Id` from requests to
   `gql.twitch.tv`, and rewrites the page's own live `PlaybackAccessToken` from `playerType:
   "site"` to `"popout"` (research-technique.md §3.7). Embed, picture-by-picture and VOD token
   requests are left alone (a deliberate narrowing of what vaft does).
4. **Worker creation** – for a Twitch-origin worker URL the subclass reads the original source
   with a synchronous XHR, builds the new blob and calls `super()` with it. If anything fails it
   calls `super()` with the original URL, so Twitch's player always gets a worker.
5. **Usher master** – the worker drops `parent_domains` from the request, then remembers every
   variant URL with its resolution, frame rate and codecs. With *Prefer AVC* it removes HEVC/AV1
   variants (and their rendition groups) when AVC exists.
6. **Media playlist** – see the algorithm in the README. Messages worker → page:
   `token-request`, `event`; page → worker: `token-response`, `settings`, `degrade`. All carry
   the key `__tas_v1`; our listeners are registered first and call `stopImmediatePropagation`
   so Twitch's handlers never see them.
7. **Events** – worker → page (`recovery.onEvent`) → bridge (toast) → background (stats,
   badge, last event). Each break counts once: `ad-detected`, then `ad-blocked-backup` and/or
   `ad-stripped` or `ad-unremovable`, then `ad-end`.

## Adaptation points

All in `src/config.js`, see the README table. Code places that encode Twitch structure beyond
config values:

- `m3u8.stripAds` – the segment model (EXTINF title `live`, CUE-OUT/IN, DATERANGE classes).
- `recovery.findPlayerAndState` – React fiber walk (`setPlayerActive` +
  `props.mediaPlayerInstance[.playerInstance]`, `setSrc` + `setInitialPlaybackSettings`).
- `gql.buildTokenBody` – persisted-query body shape.

## Recovery strategy

- **Never break the player**: every hook is in `try/catch`; on an internal exception the original
  request/response passes through untouched (`failure` event). The Worker hook falls back to the
  original URL; the worker prelude is wrapped so Twitch's code still runs if our install fails.
- **Stalls after switching** (`recovery.js`, numbers in `config.recovery`; thresholds from
  research-2026-11-13.md F6/F9): a watch is armed by `playlist-switch` / `ad-end`, and, while a
  backup or stripped playlist is served and for 30 s after native returns, by the video's
  `waiting`/`stalled` events and by pauses nobody asked for. A pause is the viewer's only if it
  follows a click/key on the player within 1.5 s (capturing listeners on the document); the
  player pausing itself during a switch is a stall. Once a second, only while the tab is
  visible: paused (not by the viewer) 2 s -> `play()`; playhead stuck 3 s, `readyState < 3` and
  a hole in `buffered` -> seek to the next range + 0.05 s; stuck with < 0.5 s buffered ahead ->
  pause/play. At most 2 soft actions per watch, 8 s apart, 6 per 2 min. Still stuck 15 s after
  the first one -> one hard reload via `setSrc({isNewMediaPlayerInstance: true,
  refreshAccessToken: true})` (not within 15 s of the previous one; `video-quality`,
  `video-muted`, `volume`, `lowLatencyModeEnabled` pinned for 5 s), skipped for a watch armed
  only by a break that stripped nothing or used a backup of native quality. Then 60 s of no
  automatic actions: no loops. Re-arming extends a watch but never resets its counters.
  `play()` rejected with `NotAllowedError`: one muted retry; sound restored at the next
  gesture unless someone unmuted meanwhile; a video the viewer muted is never touched.
  `segment-repeat` from the worker: one pause/play, at most every 20 s.
- **Reload cap**: 3 hard reloads per channel per 5 minutes. The 4th stall sets the channel to
  strip-only (`degrade` to every worker; future workers get it in `boot`) for the page session,
  reports `degraded`, and shows it in the popup. No more reloads on that channel.
- **Backup lockouts**: a player type that fails or has its own ad is skipped for 5 s; at most 5
  types per search; backup masters cached 60 s per type (the type being served keeps its master
  while its media fetch works, so a steady-state backup poll is one fetch); the last working
  non-`autoplay` type is tried first. Among equal resolutions the backup variant with the
  native `CODECS` string wins.
- **Poll deadline** (`backupPollDeadlineMs`, 1.8 s): a media poll waits at most this long for the
  backup search, then gets the stripped playlist; the search goes on in the background, one
  per channel (later polls join it). While a backup is being served, one missed poll is
  answered with what the player already has (hold, up to 4 s) instead of flipping sources.
  Leaving a backup needs 2 clean native polls in a row.
- **Order**: per channel, answers leave in request order and their state changes (switch
  events, numbering) happen in that order, so a slow older answer never overtakes a newer one.
- **Numbering** (`m3u8.resequence`, research-2026-11-13.md C1/F1/F2): once a live playlist has
  been rewritten, every answer for it is renumbered from per-playlist state. A segment is
  identified by its live number (`#EXT-X-TWITCH-LIVE-SEQUENCE` + index, up to the first
  discontinuity) where known, else by URL, and keeps the number it was first given; a segment
  the player already has (same live number, or ending before what was given) is never listed
  again under a new number, so native <-> backup switches do not make the player download a
  segment twice (the cause of the ~2 s/midroll audio drift). New segments get the next number:
  `MEDIA-SEQUENCE` and `DISCONTINUITY-SEQUENCE` are continuous and monotonic. A
  `#EXT-X-DISCONTINUITY` goes before the first new segment after a source change (native,
  `backup:<type>:<resolution>:<fps>:<codecs>`), a live-number or date-time gap, or where the
  source had one. If an appended segment still overlaps what was given (no live numbers, dates
  off by more than 0.5 s), the worker posts `segment-repeat` (once per 20 s per channel).
  Playlists never rewritten pass through untouched. Known limit: numbering is per variant URL;
  after an ABR switch mid-break, two variants may number the same time differently.
- **Empty after stripping**: the newest known segments are listed again with their numbers; the
  last clean playlist is used only while at most 6 s old.
- **Ad segment answers**: ad segments never appear in served playlists. A leftover request for
  a remembered ad URL is answered locally with one MPEG-TS null packet (or an MP4 `ftyp`),
  i.e. no media. Chosen over an empty 204 (cannot be tested against Twitch's player here) and
  over a generated silent/black segment (it would have to match the stream's codecs and
  timestamps; a mismatch is a decode error, worse than a hole the recovery watch seeks over).
- **Off switch while a tab is open**: the worker and fetch hooks see `enabled: false` and become
  passive at once; the scripts disappear on the next reload.

## Deviations from the research technique (and why)

| Research (vaft) | Here | Why |
|---|---|---|
| `eval(workerString)` of the original worker | concatenation after our prelude, `"use strict"` hoisted | no `eval` needed; same top-level semantics |
| HEVC variants swapped to AVC URLs with padded URL lines, reload onto a modified master | HEVC/AV1 variants removed when AVC exists (option, default on) | much simpler, no extra reloads; costs 1440p/4K enhanced quality while on |
| rewrite every `PlaybackAccessToken` to `popout` | only live `site` requests | leaves embeds/VODs/mini player alone |
| SERVER-TIME re-injection into cached masters | not needed | backup masters are never served to the player, only their media playlists |
| fetch one ad segment during prerolls "to start faster", ad-beacon spoofing | not done | research marks spoofing counter-productive; the prefetch trick is an ad impression |
| visibility spoofing | not done | broke other extensions (research §5) |
