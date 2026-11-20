/*
 * Stats and event texts. Pure; used by the background, the bridge (toast) and the popup.
 *
 * Counting (one count per ad break, not per playlist poll; the worker emits each once per break):
 *   ad-detected        -> detected
 *   ad-blocked-backup  -> backup      (served an ad-free backup stream)
 *   ad-stripped        -> stripped    (no clean backup: ad segments removed)
 *   ad-unremovable / failure / reload-failed -> failures
 *   standalone-ad-hidden -> standalone (cosmetic)
 *   player-reload      -> reloads
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] stats.js needs config.js first');

  var COUNTERS = {
    'ad-detected': 'detected',
    'ad-blocked-backup': 'backup',
    'ad-stripped': 'stripped',
    'ad-unremovable': 'failures',
    'failure': 'failures',
    'reload-failed': 'failures',
    'standalone-ad-hidden': 'standalone',
    'player-reload': 'reloads'
  };

  function empty() {
    return { detected: 0, backup: 0, stripped: 0, failures: 0, standalone: 0, reloads: 0 };
  }

  function normalize(s) {
    var e = empty();
    if (!s || typeof s !== 'object') return e;
    Object.keys(e).forEach(function (k) { e[k] = typeof s[k] === 'number' && s[k] >= 0 ? s[k] : 0; });
    return e;
  }

  /** Returns a new stats object with the event counted (unknown events: unchanged copy). */
  function applyEvent(stats, name) {
    var s = normalize(stats);
    var k = COUNTERS[name];
    if (k) s[k] += 1;
    return s;
  }

  function isCounted(name) {
    return Object.prototype.hasOwnProperty.call(COUNTERS, name);
  }

  function badgeText(stats) {
    var s = normalize(stats);
    var n = s.backup + s.stripped + s.standalone;
    if (n <= 0) return '';
    return n > 999 ? '999+' : String(n);
  }

  function describeEvent(name, data) {
    var d = data || {};
    var where = d.channel ? ' (' + d.channel + ')' : '';
    var kind = d.midroll ? 'Midroll' : 'Preroll';
    switch (name) {
      case 'ad-detected': return kind + ' ad detected' + where;
      case 'ad-blocked-backup': return kind + ' ad blocked using backup stream "' + (d.playerType || '?') + '"' + where;
      case 'ad-stripped': return kind + ' ad blocked by removing ' + (d.removed || 0) + ' ad segment(s)' + where;
      case 'ad-unremovable': return 'Ad markers without removable segments (client-side ad?)' + where;
      case 'ad-passthrough': return kind + ' ad played: no clean backup, and removing it would leave nothing to play' + where;
      case 'ad-end': return 'Ad break ended' + where;
      case 'failure': return 'Internal error, stream passed through untouched' + (d.where ? ' [' + d.where + ']' : '');
      case 'player-reload': return 'Player reloaded after a stall' + where;
      case 'reload-failed': return 'Player reload failed' + where;
      case 'degraded': return 'Too many reloads: strip-only mode' + where;
      case 'standalone-ad-hidden': return 'Standalone ad video hidden';
      default: return null;
    }
  }

  function toastText(name) {
    if (name === 'ad-blocked-backup') return 'Ad blocked – using backup stream';
    if (name === 'ad-stripped') return 'Ad blocked – ad segments removed, stream resumes shortly';
    if (name === 'degraded') return 'Ad Shield: strip-only mode for this channel (too many reloads)';
    return null;
  }

  /**
   * Popup status from what the popup knows.
   * @param s { url, enabled, hooked (page script answered in this tab), degraded }
   * @returns { key, text, detail, level ('ok'|'warn'|'bad'|'off'), reload (show Reload button) }
   */
  function popupStatus(s) {
    var url = String(s.url || '');
    var host = '';
    var m = /^https?:\/\/([^/:?#]+)/i.exec(url);
    if (m) host = m[1].toLowerCase();
    var isTwitch = host === 'twitch.tv' || /\.twitch\.tv$/.test(host);
    if (!isTwitch) return { key: 'not-twitch', text: 'Not a Twitch tab', detail: 'Open a Twitch channel to use the blocker.', level: 'off', reload: false };
    if (host === 'clips.twitch.tv') return { key: 'not-twitch', text: 'Not active on clips', detail: 'Clips have no stream ads.', level: 'off', reload: false };
    if (!s.enabled) {
      if (s.hooked) return { key: 'disabled', text: 'Disabled', detail: 'Still loaded in this tab until it is reloaded.', level: 'off', reload: true };
      return { key: 'disabled', text: 'Disabled', detail: 'Turn it on, then reload Twitch tabs.', level: 'off', reload: false };
    }
    if (!s.hooked) return { key: 'reload', text: 'Reload needed', detail: 'This tab was opened before the blocker was active.', level: 'warn', reload: true };
    if (s.degraded) return { key: 'degraded', text: 'Degraded (strip-only fallback)', detail: 'Too many player reloads; ads are removed without backup streams until the tab is reloaded.', level: 'warn', reload: true };
    return { key: 'active', text: 'Active on this tab', detail: 'Video ads are being handled.', level: 'ok', reload: false };
  }

  ns.stats = {
    popupStatus: popupStatus,
    empty: empty,
    normalize: normalize,
    applyEvent: applyEvent,
    isCounted: isCounted,
    badgeText: badgeText,
    describeEvent: describeEvent,
    toastText: toastText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
