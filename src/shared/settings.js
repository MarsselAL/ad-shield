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

  function defaults() {
    return {
      enabled: true,              // master switch: off = hooks pass everything through, rulesets disabled
      blockClientAds: true,       // DNR ruleset "client_ads"
      blockTrackers: false,       // DNR ruleset "trackers" (off by default)
      hideStandaloneAds: true,    // cosmetic: hide/mute standalone ad <video> elements
      preferAvc: true,            // drop HEVC/AV1 variants when AVC exists; prefer AVC backups
      playerTypes: cfg.backupPlayerTypes.slice(),
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

  /**
   * Merge a stored (possibly partial, possibly corrupt) settings object with the defaults.
   * Invalid fields fall back to their default; never throws.
   */
  function normalize(stored) {
    var d = defaults();
    var out = {};
    var s = stored && typeof stored === 'object' ? stored : {};
    Object.keys(d).forEach(function (k) {
      if (k === 'playerTypes') {
        var v = validatePlayerTypes(s.playerTypes);
        out.playerTypes = v.ok ? v.value : d.playerTypes;
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
      } else if (typeof d[k] === 'boolean' && candidate[k] !== undefined && typeof candidate[k] !== 'boolean') {
        errors.push('"' + k + '" must be true or false.');
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  ns.settings = {
    STORAGE_KEY: STORAGE_KEY,
    defaults: defaults,
    normalize: normalize,
    validate: validate,
    validatePlayerTypes: validatePlayerTypes,
    parsePlayerTypeText: parsePlayerTypeText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
