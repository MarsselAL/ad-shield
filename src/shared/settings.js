/*
 * User settings: defaults, validation and normalisation. Pure, no chrome.* or DOM use, so it
 * runs in the background, popup, options page, content scripts and the jsc tests.
 * Depends on src/config.js having been loaded first.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns || !ns.config) throw new Error('[TAS] settings.js needs config.js first');
  var cfg = ns.config;

  var STORAGE_KEY = 'settings';
  // twitchAdQuality: what plays during a Twitch stitched ad break. 'low' (default): the first
  // ad-free stream of any type, a low-quality bridge included, then native quality when the
  // break ends. 'full': same-resolution backups first, the 360p bridge only as a last resort.
  var AD_QUALITY_VALUES = ['low', 'full'];

  function defaults() {
    return {
      enabled: true,              // master switch: off = hooks pass everything through, rulesets disabled
      blockClientAds: true,       // DNR ruleset "client_ads"
      blockTrackers: false,       // DNR ruleset "trackers" (off by default)
      hideStandaloneAds: true,    // cosmetic: hide/mute standalone ad <video> elements
      preferAvc: true,            // drop HEVC/AV1 variants when AVC exists; prefer AVC backups
      playerTypes: cfg.backupPlayerTypes.slice(),
      twitchAdQuality: 'low',     // 'low' | 'full' (AD_QUALITY_VALUES)
      noticeOnAd: true,           // small toast in the player when an ad is handled
      debug: false                // verbose [TAS] logging
    };
  }

  /** Parse a playerType list from text ("site, popout" or one per line) into an array. */
  function parsePlayerTypeText(text) {
    if (typeof text !== 'string') return [];
    return text.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * Validate a playerType list. Returns { ok, value, errors } where value is the cleaned list.
   * Rules: 1..maxPlayerTypes entries, each known, no duplicates, last-resort types last.
   */
  function validatePlayerTypes(list) {
    var errors = [];
    if (!Array.isArray(list)) return { ok: false, value: null, errors: ['playerTypes must be a list'] };
    var cleaned = list.map(function (s) { return typeof s === 'string' ? s.trim() : s; });
    if (cleaned.length === 0) errors.push('At least one playerType is required.');
    if (cleaned.length > cfg.maxPlayerTypes) errors.push('At most ' + cfg.maxPlayerTypes + ' playerTypes are allowed.');
    var seen = {};
    cleaned.forEach(function (t) {
      if (typeof t !== 'string' || cfg.knownPlayerTypes.indexOf(t) === -1) {
        errors.push('Unknown playerType "' + t + '". Known: ' + cfg.knownPlayerTypes.join(', ') + '.');
      } else if (seen[t]) {
        errors.push('Duplicate playerType "' + t + '".');
      }
      seen[t] = true;
    });
    cfg.lastResortPlayerTypes.forEach(function (t) {
      var i = cleaned.indexOf(t);
      if (i !== -1 && i !== cleaned.length - 1) errors.push('"' + t + '" is a last resort and must be last.');
    });
    return { ok: errors.length === 0, value: errors.length === 0 ? cleaned : null, errors: errors };
  }

  /** An earlier release's default order (stored on install, never chosen by the viewer). */
  function isPreviousDefault(list) {
    var key = list.join(',');
    return (cfg.previousDefaultPlayerTypes || []).some(function (old) { return old.join(',') === key; });
  }

  /**
   * Merge a stored (possibly partial, possibly corrupt) settings object with the defaults.
   * Invalid fields fall back to their default, and an earlier default playerType order becomes
   * the current one; never throws.
   */
  function normalize(stored) {
    var d = defaults();
    var out = {};
    var s = stored && typeof stored === 'object' ? stored : {};
    Object.keys(d).forEach(function (k) {
      if (k === 'playerTypes') {
        var v = validatePlayerTypes(s.playerTypes);
        out.playerTypes = v.ok && !isPreviousDefault(v.value) ? v.value : d.playerTypes;
      } else if (k === 'twitchAdQuality') {
        out[k] = AD_QUALITY_VALUES.indexOf(s[k]) !== -1 ? s[k] : d[k];
      } else if (typeof d[k] === 'boolean') {
        out[k] = typeof s[k] === 'boolean' ? s[k] : d[k];
      } else {
        out[k] = d[k];
      }
    });
    return out;
  }

  /** Validate a full settings object as submitted by the options page. */
  function validate(candidate) {
    var errors = [];
    if (!candidate || typeof candidate !== 'object') return { ok: false, errors: ['settings must be an object'] };
    var d = defaults();
    Object.keys(d).forEach(function (k) {
      if (k === 'playerTypes') {
        var v = validatePlayerTypes(candidate.playerTypes);
        errors = errors.concat(v.errors);
      } else if (k === 'twitchAdQuality') {
        if (candidate[k] !== undefined && AD_QUALITY_VALUES.indexOf(candidate[k]) === -1) {
          errors.push('"twitchAdQuality" must be one of: ' + AD_QUALITY_VALUES.join(', ') + '.');
        }
      } else if (typeof d[k] === 'boolean' && candidate[k] !== undefined && typeof candidate[k] !== 'boolean') {
        errors.push('"' + k + '" must be true or false.');
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  ns.settings = {
    STORAGE_KEY: STORAGE_KEY,
    AD_QUALITY_VALUES: AD_QUALITY_VALUES,
    defaults: defaults,
    normalize: normalize,
    validate: validate,
    validatePlayerTypes: validatePlayerTypes,
    parsePlayerTypeText: parsePlayerTypeText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
