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
| `src/core/m3u8.js` | MAIN, inlined in worker, tests | Pure HLS functions: `hasAds`, `isMidroll`, `classifyDateranges`, `stripAds`, `parseMaster`, `pickVariant`, `filterMasterCodecs`, `buildUsherUrl`, `matchUsher`, `isAdSegmentUrl`. No DOM, no `URL`, no `chrome.*`. |
| `src/core/gql.js` | MAIN, tests | PlaybackAccessToken body/headers, header capture, playerType rewrite, token parsing. |
| `src/core/processor.js` | inlined in worker, tests | The backup / strip state machine with injected `fetchText`, `getToken`, `now`, `emit`. |
| `src/worker/worker-main.js` | inlined in worker | Replaces the worker's `fetch`, talks to the page, serves blank ad-segment answers. |
| `src/core/worker-source.js` | MAIN, tests | Builds the replacement worker source from the factories' `toString()` plus JSON data plus Twitch's original source. |
| `src/page/recovery.js` | MAIN | Stall monitor, soft kick, React-fiber player reload, reload rate limit, localStorage preservation. |
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
- **Stalls after switching** (`playlist-switch` or `ad-end`): watch the main (`blob:`) video for
  20 s with a 1 s timer that only exists while watching. Stalled 4 s while not paused:
  pause/play. Still stalled 4 s later: one hard reload via `setSrc({isNewMediaPlayerInstance:
  true, refreshAccessToken: true})`, with `video-quality`, `video-muted`, `volume`,
  `lowLatencyModeEnabled` pinned for 5 s (temporary `Storage.prototype.getItem` wrapper scoped
  to `localStorage`, then values written back). Then the watch ends: no loops.
- **Reload cap**: 3 hard reloads per channel per 5 minutes. The 4th stall sets the channel to
  strip-only (`degrade` to every worker; future workers get it in `boot`) for the page session,
  reports `degraded`, and shows it in the popup. No more reloads on that channel.
- **Backup lockouts**: a player type that fails or has its own ad is skipped for 5 s; at most 5
  types per poll; backup masters cached 60 s per type; the last working non-`autoplay` type is
  tried first.
- **Empty after stripping**: the last clean playlist is served for up to 20 s.
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
