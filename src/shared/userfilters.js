/*
 * "My filters": element-hiding selectors the user added with the element picker or typed on the
 * options page. Pure functions (no chrome.*, no DOM), used by the background, the options page
 * and the jsc tests. Loaded after src/shared/blocking.js (host helpers).
 *
 * Storage: chrome.storage.local key "userFilters" = { "example.com": ["selector", ...], ... }.
 * Keys are hosts (a key covers its subdomains); the picker saves under siteKey(page host)
 * (without "www."). Caps: MAX_PER_HOST selectors per host, MAX_TOTAL in all, MAX_LENGTH chars
 * per selector. Per-site only: there are no global (host-less) user filters.
 * Text format (options page): one "host##selector" per line, "a.com,b.com##sel" for several
 * hosts, "!" starts a comment line (comments are not stored).
 * Applied (src/background/general.js) whenever the master switch is on and the site is not
 * allowlisted, independent of the Ads / Cookie-banner switches; top frame only.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};
  var B = ns.blocking;

  var STORAGE_KEY = 'userFilters';
  var MAX_PER_HOST = 200;
  var MAX_TOTAL = 5000;
  var MAX_LENGTH = 500;

  /**
   * Conservative syntax check without a DOM (the background has none). Returns an error message
   * or null. It cannot prove a selector valid (the picker and the options page also run
   * querySelectorAll); it rejects anything that could escape the "selector{display:none}" rule
   * we build: braces, comments, at-rules, control characters, unbalanced brackets or quotes.
   */
  function selectorError(sel) {
    if (typeof sel !== 'string') return 'not text';
    var s = sel.trim();
    if (!s) return 'empty selector';
    if (s.length > MAX_LENGTH) return 'longer than ' + MAX_LENGTH + ' characters';
    if (/[\x00-\x1f\x7f]/.test(s)) return 'contains control characters';
    if (s.indexOf('/*') !== -1 || s.indexOf('*/') !== -1) return 'must not contain comments';
    if (s.charAt(0) === '@') return 'at-rules are not selectors';
    if (/^[>+~,]/.test(s) || /[>+~,]$/.test(s)) return 'starts or ends with a combinator or comma';
    if (/\\$/.test(s)) return 'ends with a backslash';
    var stack = [], quote = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{' || c === '}' || c === ';') return 'must not contain { } or ; outside quotes';
      if (c === '[' || c === '(') stack.push(c);
      else if (c === ']' || c === ')') {
        var open = stack.pop();
        if ((c === ']' && open !== '[') || (c === ')' && open !== '(')) return 'unbalanced brackets';
      }
    }
    if (quote) return 'unclosed quote';
    if (stack.length) return 'unbalanced brackets';
    return null;
  }

  function hostKey(h) {
    return B.normalizeHost(h);
  }

  function total(obj) {
    var n = 0;
    Object.keys(obj).forEach(function (h) { n += obj[h].length; });
    return n;
  }

  /** Stored (possibly corrupt) value -> { host: [selectors] }, caps applied; never throws. */
  function normalize(stored) {
    var out = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
    var n = 0;
    Object.keys(stored).sort().forEach(function (k) {
      var h = hostKey(k);
      var list = stored[k];
      if (!h || h !== k || !Array.isArray(list)) return;
      var seen = {}, sels = [];
      list.forEach(function (x) {
        if (typeof x !== 'string') return;
        var s = x.trim();
        if (selectorError(s) || seen[s] || sels.length >= MAX_PER_HOST || n >= MAX_TOTAL) return;
        seen[s] = true;
        sels.push(s);
        n++;
      });
      if (sels.length) out[h] = sels;
    });
    return out;
  }

  /** Add one selector for a host (the picker). Returns { ok, value, error, added }. */
  function add(stored, host, selector) {
    var cur = normalize(stored);
    var h = hostKey(host);
    if (!h) return { ok: false, value: cur, error: 'Not a valid site.' };
    var s = typeof selector === 'string' ? selector.trim() : '';
    var err = selectorError(s);
    if (err) return { ok: false, value: cur, error: 'Selector ' + err + '.' };
    var list = cur[h] || [];
    if (list.indexOf(s) !== -1) return { ok: true, value: cur, error: null, added: false };
    if (list.length >= MAX_PER_HOST) return { ok: false, value: cur, error: 'At most ' + MAX_PER_HOST + ' filters per site.' };
    if (total(cur) >= MAX_TOTAL) return { ok: false, value: cur, error: 'At most ' + MAX_TOTAL + ' filters in all.' };
    var next = Object.assign({}, cur);
    next[h] = list.concat([s]);
    return { ok: true, value: next, error: null, added: true };
  }

  /**
   * Parse the options-page text. Returns { ok, value, errors } where errors are "Line N: ..."
   * messages and value is null when there are errors. `check(selector)` (optional, the options
   * page passes a querySelectorAll test) returns an error message or null.
   */
  function parseText(text, check) {
    var errors = [], out = {}, n = 0;
    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var line = raw.trim();
      var where = 'Line ' + (i + 1) + ': ';
      if (!line || line.charAt(0) === '!') return;
      if (/#@#|#\?#|#\$#|#@\?#|#@\$#|##\+js|#%#/.test(line)) {
        errors.push(where + 'only "site##selector" hiding rules are supported here.');
        return;
      }
      var at = line.indexOf('##');
      if (at === -1) { errors.push(where + 'expected "site##selector", for example example.com##.ad-box'); return; }
      var hostPart = line.slice(0, at).trim(), sel = line.slice(at + 2).trim();
      if (!hostPart) { errors.push(where + 'add the site before ## (filters here are per site, e.g. example.com##' + sel + ').'); return; }
      var hosts = [], bad = null;
      hostPart.split(',').forEach(function (x) {
        var t = x.trim();
        var h = t.charAt(0) === '~' ? null : hostKey(t);
        if (!h || /[*/:]/.test(t)) bad = bad || t;
        else if (hosts.indexOf(h) === -1) hosts.push(h);
      });
      if (bad !== null) { errors.push(where + 'not a valid site: "' + bad + '".'); return; }
      var err = selectorError(sel) || (check ? check(sel) : null);
      if (err) { errors.push(where + 'selector ' + err + '.'); return; }
      hosts.forEach(function (h) {
        var list = out[h] = out[h] || [];
        if (list.indexOf(sel) !== -1) return;
        list.push(sel);
        n++;
        if (list.length === MAX_PER_HOST + 1) errors.push(where + 'more than ' + MAX_PER_HOST + ' filters for ' + h + '.');
      });
    });
    if (n > MAX_TOTAL) errors.push('More than ' + MAX_TOTAL + ' filters in all.');
    return { ok: errors.length === 0, value: errors.length ? null : normalize(out), errors: errors };
  }

  /** { host: [selectors] } -> text, hosts sorted, one "host##selector" per line. */
  function toText(stored) {
    var obj = normalize(stored), lines = [];
    Object.keys(obj).sort().forEach(function (h) {
      obj[h].forEach(function (s) { lines.push(h + '##' + s); });
    });
    return lines.join('\n');
  }

  /** Selectors that apply to a page host (its own and its parent domains' entries). */
  function selectorsFor(host, stored) {
    var obj = stored && typeof stored === 'object' ? stored : {};
    var out = [], seen = {};
    B.hostCandidates(host).forEach(function (c) {
      var list = Object.prototype.hasOwnProperty.call(obj, c) && Array.isArray(obj[c]) ? obj[c] : [];
      list.forEach(function (s) {
        if (typeof s !== 'string' || seen[s] || selectorError(s)) return;
        seen[s] = true;
        out.push(s);
      });
    });
    return out;
  }

  /** CSS for a host: one rule per selector, so an invalid selector only drops itself. */
  function cssFor(host, stored) {
    return selectorsFor(host, stored).map(function (s) { return s + '{display:none!important}'; }).join('\n');
  }

  /** Hosts with at least one filter (for the page script's match patterns). */
  function hosts(stored) {
    return Object.keys(normalize(stored)).sort();
  }

  ns.userFilters = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_PER_HOST: MAX_PER_HOST,
    MAX_TOTAL: MAX_TOTAL,
    MAX_LENGTH: MAX_LENGTH,
    selectorError: selectorError,
    normalize: normalize,
    add: add,
    parseText: parseText,
    toText: toText,
    selectorsFor: selectorsFor,
    cssFor: cssFor,
    hosts: hosts
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
