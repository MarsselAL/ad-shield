/*
 * Occasional "please consider supporting" note in the popup (the support panel glows once and
 * shows thanks(count)). Pure logic (no chrome.* calls), used by
 * the popup, the settings page and the service worker, and tested in tests/supportprompt.test.js.
 *
 * Calm by design:
 *  - shown only inside the popup, never in web pages, no tabs, windows or notifications;
 *  - first eligible after BOTH 7 days since install AND 1,000 ads blocked; after that at most once
 *    every 60 days and only at a new milestone (10,000, 50,000, 100,000 ...);
 *  - never on the first popup open after an install or an update;
 *  - snooze() (60 days) is kept for callers; "Don't remind me" and the settings switch turn it off.
 *
 * The ads count is a lower bound: the popup adds the per-page count it already reads each time it
 * opens (no extra getMatchedRules calls), deduplicated by tab + URL + document load, so the note
 * says "at least N ads". Storage (chrome.storage.local, keys used by nothing else):
 *   adbrakeInstalledAt   ms timestamp; set on install, or on the first popup open for older installs
 *   adbrakeSeenBlocked   { total, lastKey, lastCount }
 *   adbrakeSupportPrompt { version, lastShownAt, lastMilestone, snoozedUntil, never, reminders }
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};
  var DAY = 24 * 60 * 60 * 1000;
  var MILESTONES = [1000, 10000, 50000, 100000, 250000, 500000, 1000000];

  function num(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; }

  function normalizeSeen(s) {
    s = s && typeof s === 'object' ? s : {};
    return { total: num(s.total), lastKey: typeof s.lastKey === 'string' ? s.lastKey : '', lastCount: num(s.lastCount) };
  }

  function normalizeState(s) {
    s = s && typeof s === 'object' ? s : {};
    return {
      version: typeof s.version === 'string' ? s.version : '',
      lastShownAt: num(s.lastShownAt),
      lastMilestone: num(s.lastMilestone),
      snoozedUntil: num(s.snoozedUntil),
      never: s.never === true,
      reminders: s.reminders !== false
    };
  }

  /** The key that identifies one page load in one tab. */
  function pageKey(tabId, url, loadedAt) { return String(tabId) + '|' + String(url || '') + '|' + String(loadedAt || 0); }

  /**
   * Adds the blocked count the popup read for one page load. Reopening the popup on the same load
   * adds only the growth since the last read; a different load adds its whole count.
   */
  function accumulate(seen, key, count) {
    var s = normalizeSeen(seen);
    var c = num(count);
    if (key && key === s.lastKey) {
      return { total: s.total + Math.max(0, c - s.lastCount), lastKey: key, lastCount: Math.max(s.lastCount, c) };
    }
    return { total: s.total + c, lastKey: key || '', lastCount: c };
  }

  /** Highest milestone reached by n (0 below the first). */
  function milestoneFor(n) {
    var m = 0;
    for (var i = 0; i < MILESTONES.length; i++) if (n >= MILESTONES[i]) m = MILESTONES[i];
    return m;
  }

  /**
   * o: { now, installedAt, seen, state, version, hasLink }
   * Returns { show, reason, milestone, count, firstOpen }. firstOpen = this is the first popup open
   * since install or update (the caller stores state.version = version).
   */
  function decide(o) {
    var st = normalizeState(o.state);
    var seen = normalizeSeen(o.seen);
    var now = num(o.now);
    var r = { show: false, reason: '', milestone: milestoneFor(seen.total), count: seen.total,
      firstOpen: st.version !== String(o.version || '') };
    if (!o.hasLink) { r.reason = 'no-link'; return r; }
    if (st.never) { r.reason = 'never'; return r; }
    if (!st.reminders) { r.reason = 'off'; return r; }
    if (r.firstOpen) { r.reason = 'first-open'; return r; }
    if (!num(o.installedAt) || now - num(o.installedAt) < 7 * DAY) { r.reason = 'too-new'; return r; }
    if (r.milestone < MILESTONES[0]) { r.reason = 'below-milestone'; return r; }
    if (r.milestone <= st.lastMilestone) { r.reason = 'same-milestone'; return r; }
    if (now < st.snoozedUntil) { r.reason = 'snoozed'; return r; }
    if (st.lastShownAt && now - st.lastShownAt < 60 * DAY) { r.reason = 'recently-shown'; return r; }
    r.show = true;
    r.reason = 'milestone';
    return r;
  }

  function shown(state, now, milestone) {
    return Object.assign(normalizeState(state), { lastShownAt: num(now), lastMilestone: num(milestone) });
  }
  function snooze(state, now) { return Object.assign(normalizeState(state), { snoozedUntil: num(now) + 60 * DAY }); }
  function never(state) { return Object.assign(normalizeState(state), { never: true, reminders: false }); }
  function setReminders(state, on) {
    var s = normalizeState(state);
    return Object.assign(s, { reminders: !!on, never: on ? false : s.never });
  }

  /** 1234567 -> "1,234,567" (no locale APIs, same output everywhere). */
  function formatCount(n) { return String(Math.floor(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function message(count) {
    return 'AdBrake has blocked at least ' + formatCount(count) + ' ads for you. Keeping it free and up to date ' +
      'takes time. If it’s useful to you, consider supporting development.';
  }

  /** The short line the popup shows beside the support panel's one-time glow. */
  function thanks(count) {
    return 'Thanks for using AdBrake: at least ' + formatCount(count) + ' ads blocked so far.';
  }

  ns.supportPrompt = Object.freeze({
    INSTALL_KEY: 'adbrakeInstalledAt',
    SEEN_KEY: 'adbrakeSeenBlocked',
    STATE_KEY: 'adbrakeSupportPrompt',
    DAY: DAY,
    MILESTONES: MILESTONES,
    normalizeSeen: normalizeSeen,
    normalizeState: normalizeState,
    pageKey: pageKey,
    accumulate: accumulate,
    milestoneFor: milestoneFor,
    decide: decide,
    shown: shown,
    snooze: snooze,
    never: never,
    setReminders: setReminders,
    formatCount: formatCount,
    message: message,
    thanks: thanks
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
