/*
 * Decides whether our page / bridge scripts should run in the current frame and page.
 * Pure (location values are passed in) so it is testable.
 * Rules (docs/research-technique.md §3 item 6): top frame always, except clip pages;
 * sub-frames only for the Twitch player (player.twitch.tv, embed.twitch.tv, /embed/ paths).
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) throw new Error('[TAS] frame.js needs config.js first');
  var cfg = ns.config;

  function shouldRunInFrame(hostname, pathname, isTop) {
    var host = String(hostname || '').toLowerCase();
    var path = String(pathname || '/');
    if (host === 'clips.twitch.tv') return false;
    if (new RegExp(cfg.skipPathPattern).test(path)) return false;
    if (isTop) return true;
    if (cfg.allowedFrameHosts.indexOf(host) !== -1) return true;
    return path.indexOf(cfg.allowedFramePathPrefix) === 0;
  }

  function isTopFrame(win) {
    try { return win.top === win; } catch (e) { return false; }
  }

  ns.frame = { shouldRunInFrame: shouldRunInFrame, isTopFrame: isTopFrame };
})(typeof globalThis !== 'undefined' ? globalThis : this);
