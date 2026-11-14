/*
 * Adblock-style filter list -> declarativeNetRequest rules and site-specific cosmetic data.
 * A line-by-line port of tools/filterlist.py and convert_texts() in tools/build_rules.py (our
 * own code, MIT), used by the background's weekly list update (src/background/updater.js).
 * tests/filterlist.test.js checks that it produces exactly tests/fixtures/lists/golden.json,
 * which tests/test_rules.py checks against the Python converter, so the two cannot drift.
 * Python semantics are kept on purpose: str.strip() whitespace, str.splitlines() separators,
 * json.dumps(sort_keys=True) group keys and their sort order, and Python's "idna" codec
 * (IDNA 2003: nameprep + punycode) for international domain names.
 * Pure functions: no chrome.*, no DOM. Runs in the service worker and in jsc.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};

  var PRIORITY_BLOCK = 1;
  var PRIORITY_ALLOW = 2;
  var PRIORITY_IMPORTANT = 3;
  var PRIORITY_ALLOW_IMPORTANT = 4;
  var ALLOW_ID_BASE = 500000;          // must equal tools/filterlist.py and blocking.js
  var DOMAINS_PER_RULE = 1000;
  var MAX_REGEX_RULES_PER_LIST = 200;

  // (key, category) as LISTS in tools/build_rules.py; category null = no cosmetic filters.
  var LISTS = [
    { key: 'easylist', category: 'ads' },
    { key: 'easyprivacy', category: null },
    { key: 'easylist-cookie', category: 'cookies' }
  ];

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function set(arr) { var s = new Set(); arr.forEach(function (x) { s.add(x); }); return s; }

  var TYPE_MAP = {
    script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
    object: 'object', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
    subdocument: 'sub_frame', frame: 'sub_frame', ping: 'ping', beacon: 'ping',
    media: 'media', font: 'font', websocket: 'websocket', other: 'other',
    document: 'main_frame', doc: 'main_frame'
  };
  var COSMETIC_ONLY_OPTIONS = set(['generichide', 'ghide', 'elemhide', 'ehide', 'specifichide', 'shide']);
  var COSMETIC_ALIAS = { ghide: 'generichide', ehide: 'elemhide', shide: 'specifichide' };
  var UNSUPPORTED_OPTIONS = set([
    'redirect', 'redirect-rule', 'rewrite', 'csp', 'removeparam', 'queryprune', 'header',
    'replace', 'badfilter', 'sitekey', 'empty', 'mp4', 'inline-script', 'inline-font', 'cname',
    'denyallow', 'to', 'method', 'permissions', 'urltransform', 'uritransform', 'all',
    'strict1p', 'strict3p', 'popunder', 'webrtc', 'object-subrequest', 'genericblock',
    'urlskip', 'reason', 'ipaddress', 'responseheader', 'requestheader'
  ]);
  var PROCEDURAL_MARKERS = [
    ':-abp-', ':has-text(', ':contains(', ':xpath(', ':upward(', ':remove(', ':style(',
    ':matches-css', ':min-text-length(', ':watch-attr(', ':others(', ':matches-path(',
    ':matches-attr(', ':matches-prop(', ':if(', ':if-not(', ':nth-ancestor(', ':remove-attr(',
    ':remove-class(', ':matches-media(', ':shadow', ':-ext-'
  ];
  var OPTION_TOKEN = '~?[A-Za-z0-9_-]+(?:=[^,]*)?';
  var OPTIONS_RE = new RegExp('^' + OPTION_TOKEN + '(?:,' + OPTION_TOKEN + ')*$');
  var HOST_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
  var PLAIN_DOMAIN_RE = /^\|\|([a-z0-9_.-]+)\^$/;
  var COSMETIC_RE = /^([^#]*)(#@?(?:\$\?|[?$%])?#)(.*)$/;
  var TRACKER_COOKIE_RE = /^\|\|([a-z0-9_.-]+)\^\$third-party$/;

  // ---------------------------------------------------------------- Python string helpers
  // Characters Python's str.strip()/str.isspace() treat as whitespace.
  var PY_WS = '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005' +
    '\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  function stripChars(s, chars) {
    var a = 0, b = s.length;
    while (a < b && chars.indexOf(s.charAt(a)) !== -1) a++;
    while (b > a && chars.indexOf(s.charAt(b - 1)) !== -1) b--;
    return s.slice(a, b);
  }
  function pyStrip(s) { return stripChars(s, PY_WS); }
  function rstripChars(s, chars) {
    var b = s.length;
    while (b > 0 && chars.indexOf(s.charAt(b - 1)) !== -1) b--;
    return s.slice(0, b);
  }
  // str.splitlines(): \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029; no trailing empty item.
  function splitLines(text) {
    var lines = String(text).split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  function isAscii(s) { return /^[\x00-\x7f]*$/.test(s); }
  function startsWith(s, p) { return s.slice(0, p.length) === p; }
  function endsWith(s, p) { return p.length <= s.length && s.slice(s.length - p.length) === p; }

  /** Python's sorted() order for strings (code points, not UTF-16 units). */
  function pyCmp(a, b) {
    if (a === b) return 0;
    if (!/[\ud800-\udfff]/.test(a + b)) return a < b ? -1 : 1;
    var x = Array.from(a), y = Array.from(b), n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) {
      if (x[i] !== y[i]) return x[i].codePointAt(0) < y[i].codePointAt(0) ? -1 : 1;
    }
    return x.length < y.length ? -1 : 1;
  }
  function sortedUnique(arr) {
    return Array.from(set(arr)).sort(pyCmp);
  }

  /** json.dumps(value, sort_keys=True) with Python's default separators and ensure_ascii. */
  function pyJson(v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') {
      return '"' + v.replace(/[\\"]|[^ -~]/g, function (c) {
        if (c === '\\') return '\\\\';
        if (c === '"') return '\\"';
        var m = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }[c];
        if (m) return m;
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
      }) + '"';
    }
    if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
    return '{' + Object.keys(v).sort(pyCmp).map(function (k) { return pyJson(k) + ': ' + pyJson(v[k]); }).join(', ') + '}';
  }

  // ---------------------------------------------------------------- IDNA 2003 (Python "idna")
  var B1_RE = /[\u00ad\u034f\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g;
  // Prohibited after nameprep (RFC 3491 tables C.1.2-C.9, simplified to the ranges that matter).
  var PROHIBITED_RE = /[\u0080-\u009f\u00a0\u0340\u0341\u06dd\u070f\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2063\u206a-\u206f\u2ff0-\u2ffb\u3000\ud800-\udfff\ue000-\uf8ff\ufdd0-\ufdef\ufff9-\uffff]/;
  var RANDAL_RE = /[\u05be\u05c0\u05c3\u05d0-\u05f4\u0608\u060b\u060d\u061b-\u064a\u066d-\u066f\u0671-\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u0710\u0712-\u072f\u074d-\u07a5\u07b1-\u07ea\u07f4\u07f5\u07fa-\u0815\u200f\ufb1d\ufb1f-\ufb28\ufb2a-\ufd3d\ufd50-\ufdfc\ufe70-\ufefc]/;
  var SPECIAL_FOLD = { '\u00df': 'ss', '\u03c2': '\u03c3', '\u1e9e': 'ss' };

  function nameprep(label) {
    var s = label.replace(B1_RE, '');
    s = Array.from(s).map(function (c) { return own(SPECIAL_FOLD, c) ? SPECIAL_FOLD[c] : c.toLowerCase(); }).join('');
    s = s.normalize('NFKC');
    if (PROHIBITED_RE.test(s)) throw new Skip('bad-domain');
    var chars = Array.from(s);
    if (chars.some(function (c) { return RANDAL_RE.test(c); })) {
      var hasL = chars.some(function (c) { return /\p{L}/u.test(c) && !RANDAL_RE.test(c); });
      if (hasL || !RANDAL_RE.test(chars[0]) || !RANDAL_RE.test(chars[chars.length - 1])) throw new Skip('bad-domain');
    }
    return s;
  }

  /** RFC 3492 punycode encoding of one label (code points). */
  function punycode(input) {
    var cps = Array.from(input).map(function (c) { return c.codePointAt(0); });
    var base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700;
    var n = 128, delta = 0, bias = 72, out = '';
    function digit(d) { return String.fromCharCode(d < 26 ? 97 + d : 22 + d); }
    function adapt(d, numPoints, first) {
      d = first ? Math.floor(d / damp) : d >> 1;
      d += Math.floor(d / numPoints);
      var k = 0;
      while (d > ((base - tmin) * tmax) >> 1) { d = Math.floor(d / (base - tmin)); k += base; }
      return k + Math.floor(((base - tmin + 1) * d) / (d + skew));
    }
    cps.forEach(function (c) { if (c < 128) out += String.fromCharCode(c); });
    var b = out.length, h = b;
    if (b > 0) out += '-';
    while (h < cps.length) {
      var m = Infinity;
      cps.forEach(function (c) { if (c >= n && c < m) m = c; });
      delta += (m - n) * (h + 1);
      n = m;
      for (var i = 0; i < cps.length; i++) {
        var c = cps[i];
        if (c < n) delta++;
        if (c === n) {
          var q = delta;
          for (var k = base; ; k += base) {
            var t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
            if (q < t) break;
            out += digit(t + ((q - t) % (base - t)));
            q = Math.floor((q - t) / (base - t));
          }
          out += digit(q);
          bias = adapt(delta, h + 1, h === b);
          delta = 0;
          h++;
        }
      }
      delta++;
      n++;
    }
    return out;
  }

  /** Python's host.encode("idna").decode("ascii") for a non-ASCII host; throws Skip. */
  function idnaEncode(host) {
    var labels = host.split(/[.\u3002\uff0e\uff61]/);
    var trailing = '';
    if (labels.length > 1 && labels[labels.length - 1] === '') { labels.pop(); trailing = '.'; }
    return labels.map(function (label) {
      var l = label;
      if (!isAscii(l)) {
        l = nameprep(l);
        if (!isAscii(l)) {
          if (startsWith(l.toLowerCase(), 'xn--')) throw new Skip('bad-domain');
          l = 'xn--' + punycode(l);
        }
      }
      if (l.length < 1 || l.length > 63) throw new Skip('bad-domain');
      return l;
    }).join('.') + trailing;
  }

  // ---------------------------------------------------------------- parsing
  function Skip(reason) { this.reason = reason; }
  Skip.prototype.toString = function () { return this.reason; };

  function toAsciiHost(host) {
    var h = rstripChars(pyStrip(host).toLowerCase(), '.');
    if (!h) throw new Skip('empty-domain');
    if (!isAscii(h)) h = idnaEncode(h);
    if (!HOST_RE.test(h)) throw new Skip('bad-domain');
    return h;
  }

  function parseDomainList(value, sep) {
    var inc = [], exc = [], dropped = false;
    value.split(sep).forEach(function (raw) {
      var part = pyStrip(raw);
      if (!part) return;
      var neg = startsWith(part, '~');
      var name = neg ? part.slice(1) : part;
      if (name.indexOf('*') !== -1 || startsWith(name, '/')) {
        if (neg) throw new Skip('wildcard-domain');
        dropped = true;
        return;
      }
      (neg ? exc : inc).push(toAsciiHost(name));
    });
    if (dropped && !inc.length) throw new Skip('wildcard-domain');
    return [sortedUnique(inc), sortedUnique(exc)];
  }

  function classify(line) {
    var s = pyStrip(line);
    if (!s || startsWith(s, '!') || (startsWith(s, '[') && endsWith(s, ']'))) return ['comment', null];
    var m = COSMETIC_RE.exec(s);
    if (m && !startsWith(s, '@@') && m[1].indexOf('/') === -1 && m[1].indexOf('$') === -1) return ['cosmetic', [m[1], m[2], m[3]]];
    return ['network', s];
  }

  function splitOptions(text) {
    var i = text.lastIndexOf('$');
    if (i <= 0 && !startsWith(text, '$')) return [text, ''];
    var cand = text.slice(i + 1);
    if (cand && OPTIONS_RE.test(cand) && !(startsWith(text, '/') && endsWith(cand, '/'))) return [text.slice(0, i), cand];
    return [text, ''];
  }

  // Escapes Python's re module accepts (it rejects other ASCII letters after a backslash).
  var PY_ESCAPES = 'abfnrtvdDsSwWbBAZx0123456789uUN';
  function pyRegexValid(rx) {
    for (var i = 0; i < rx.length; i++) {
      if (rx.charAt(i) !== '\\') continue;
      var c = rx.charAt(i + 1);
      if (/[A-Za-z]/.test(c) && PY_ESCAPES.indexOf(c) === -1) return false;
      i++;
    }
    try { new RegExp(rx); } catch (e) { return false; }
    return true;
  }

  function isRe2Safe(rx) {
    if (!rx || rx.length > 200 || !isAscii(rx)) return false;
    var bad = ['(?=', '(?!', '(?<', '(?>', '(?P'];
    for (var i = 0; i < bad.length; i++) if (rx.indexOf(bad[i]) !== -1) return false;
    if (/\\[1-9]/.test(rx)) return false;
    var re = /\{(\d+)(?:,(\d*))?\}/g, m;
    while ((m = re.exec(rx))) {
      if (parseInt(m[1], 10) > 20 || (m[2] && parseInt(m[2], 10) > 20)) return false;
    }
    var star = rx.indexOf('.*');
    if (star !== -1 && /[({]/.test(rx.slice(star + 2))) return false;
    return pyRegexValid(rx);
  }

  function parseNetwork(text) {
    var allow = startsWith(text, '@@');
    var body = allow ? text.slice(2) : text;
    var po = splitOptions(body), pattern = po[0], opts = po[1];
    if (pattern.indexOf(' ') !== -1 || pattern.indexOf('\t') !== -1) throw new Skip('whitespace');
    var cond = {};
    var domainType = null;
    var types = new Set(), exclTypes = new Set();
    var hasPopup = false, matchCase = false, important = false;
    var cosmetic = new Set();
    (opts ? opts.split(',') : []).forEach(function (r) {
      var raw = pyStrip(r);
      if (!raw) return;
      var eq = raw.indexOf('=');
      var name = (eq === -1 ? raw : raw.slice(0, eq)).toLowerCase();
      var value = eq === -1 ? '' : raw.slice(eq + 1);
      var neg = startsWith(name, '~');
      var b = neg ? name.slice(1) : name;
      if (b === 'third-party' || b === '3p') domainType = neg ? 'firstParty' : 'thirdParty';
      else if (b === 'first-party' || b === '1p') domainType = neg ? 'thirdParty' : 'firstParty';
      else if (own(TYPE_MAP, b) && !value) (neg ? exclTypes : types).add(TYPE_MAP[b]);
      else if (b === 'popup' && !neg) hasPopup = true;
      else if (b === 'popup') return;
      else if ((b === 'domain' || b === 'from') && !neg) {
        if (!value) throw new Skip('bad-option');
        var d = parseDomainList(value, '|');
        if (d[0].length) cond.initiatorDomains = d[0];
        if (d[1].length) cond.excludedInitiatorDomains = d[1];
      } else if (b === 'match-case' && !neg) matchCase = true;
      else if (b === 'important' && !neg) important = true;
      else if (COSMETIC_ONLY_OPTIONS.has(b) && !neg) cosmetic.add(own(COSMETIC_ALIAS, b) ? COSMETIC_ALIAS[b] : b);
      else if (UNSUPPORTED_OPTIONS.has(b)) throw new Skip('option:' + b);
      else throw new Skip('option:unknown');
    });

    if (cosmetic.size) {
      if (!allow) throw new Skip('cosmetic-option-on-block');
      var cm = PLAIN_DOMAIN_RE.exec(pattern.toLowerCase());
      if (!cm || types.size || Object.keys(cond).length) throw new Skip('cosmetic-exception-pattern');
      return { allow: true, cosmeticException: cosmetic, host: toAsciiHost(cm[1]) };
    }

    if (hasPopup && !types.size) throw new Skip('popup');
    if (types.has('main_frame') && !allow && types.size > 1) types.delete('main_frame');
    if (!allow && types.size === 1 && types.has('main_frame')) throw new Skip('document-block');

    var action = allow ? 'allow' : 'block';
    if (allow && types.has('main_frame')) {
      action = 'allowAllRequests';
      types = set(['main_frame', 'sub_frame']);
      exclTypes = new Set();
    }

    var plain = null;
    if (startsWith(pattern, '/') && endsWith(pattern, '/') && pattern.length > 2) {
      var rx = pattern.slice(1, -1);
      if (!isRe2Safe(rx)) throw new Skip('regex');
      cond.regexFilter = rx;
    } else {
      var p = pattern;
      if (!isAscii(p)) throw new Skip('non-ascii');
      if (startsWith(p, '||*')) p = '*' + p.slice(3);
      while (startsWith(p, '**')) p = p.slice(1);
      var inner = startsWith(p, '||') ? p.slice(2) : startsWith(p, '|') ? p.slice(1) : p;
      inner = endsWith(inner, '|') ? inner.slice(0, -1) : inner;
      if (inner.indexOf('|') !== -1) throw new Skip('pipe-in-pattern');
      if (['', '*', '|', '||', '|*', '*|'].indexOf(p) !== -1) {
        if (!(cond.initiatorDomains && cond.initiatorDomains.length)) throw new Skip('too-broad');
      } else {
        if (stripChars(p, '*|^').length < 3 && !(cond.initiatorDomains && cond.initiatorDomains.length)) throw new Skip('too-broad');
        var m = PLAIN_DOMAIN_RE.exec(p.toLowerCase());
        if (m && !matchCase) {
          try { plain = toAsciiHost(m[1]); } catch (e) {
            if (!(e instanceof Skip)) throw e;
            plain = null;
          }
        }
        if (plain === null) cond.urlFilter = p;
      }
    }
    if (matchCase) cond.isUrlFilterCaseSensitive = true;
    if (domainType) cond.domainType = domainType;
    if (types.size) cond.resourceTypes = Array.from(types).sort(pyCmp);
    else if (exclTypes.size) cond.excludedResourceTypes = Array.from(exclTypes).sort(pyCmp);
    var priority = allow ? (important ? PRIORITY_ALLOW_IMPORTANT : PRIORITY_ALLOW) : (important ? PRIORITY_IMPORTANT : PRIORITY_BLOCK);
    return { allow: allow, cosmeticException: null, action: action, priority: priority, condition: cond, plainDomain: plain };
  }

  function removeCovered(domains) {
    var s = set(domains), out = [];
    Array.from(s).sort(pyCmp).forEach(function (d) {
      var parts = d.split('.');
      for (var i = 1; i < parts.length; i++) if (s.has(parts.slice(i).join('.'))) return;
      out.push(d);
    });
    return out;
  }

  /** Python build_network_rules: returns { rules, stats }. */
  function buildNetworkRules(parsed, maxRegex) {
    if (maxRegex === undefined) maxRegex = MAX_REGEX_RULES_PER_LIST;
    var groups = new Map(), singles = [], seen = new Set(), regexCount = 0;
    var stats = { 'merged-domains': 0, regex: 0, duplicates: 0, 'regex-cap': 0 };
    parsed.forEach(function (p) {
      if (p.cosmeticException) return;
      var cond = p.condition;
      var key = pyJson([p.action, p.priority, cond]);
      if (p.plainDomain) {
        if (!groups.has(key)) groups.set(key, { action: p.action, priority: p.priority, cond: cond, domains: [] });
        groups.get(key).domains.push(p.plainDomain);
        return;
      }
      if (seen.has(key)) { stats.duplicates++; return; }
      if (own(cond, 'regexFilter')) {
        if (regexCount >= maxRegex) { stats['regex-cap']++; return; }
        regexCount++;
      }
      seen.add(key);
      singles.push([p.action, p.priority, cond]);
    });
    stats.regex = regexCount;
    var block = [], allow = [];
    Array.from(groups.keys()).sort(pyCmp).forEach(function (key) {
      var g = groups.get(key);
      var doms = removeCovered(g.domains);
      stats['merged-domains'] += doms.length;
      for (var i = 0; i < doms.length; i += DOMAINS_PER_RULE) {
        var c = Object.assign({}, g.cond);
        c.requestDomains = doms.slice(i, i + DOMAINS_PER_RULE);
        (g.action !== 'block' ? allow : block).push([g.action, g.priority, c]);
      }
    });
    singles.forEach(function (x) { (x[0] !== 'block' ? allow : block).push(x); });
    var rules = [];
    block.forEach(function (x, i) { rules.push({ id: i + 1, priority: x[1], action: { type: x[0] }, condition: x[2] }); });
    allow.forEach(function (x, i) { rules.push({ id: ALLOW_ID_BASE + i + 1, priority: x[1], action: { type: x[0] }, condition: x[2] }); });
    return { rules: rules, stats: stats };
  }

  function isTrackerCookieDomain(text) {
    var m = TRACKER_COOKIE_RE.exec(pyStrip(text).toLowerCase());
    return m ? m[1] : null;
  }

  function balanced(sel) {
    var paren = 0, bracket = 0, quote = null, esc = false;
    for (var i = 0; i < sel.length; i++) {
      var ch = sel.charAt(i);
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '}' || ch === ';') return false;
      else if (ch === '(') paren++;
      else if (ch === '[') bracket++;
      else if (ch === ')') paren--;
      else if (ch === ']') bracket--;
      if (paren < 0 || bracket < 0) return false;
    }
    return quote === null && paren === 0 && bracket === 0;
  }

  /** Returns [exception, includedHosts, excludedHosts, selector]; throws Skip. */
  function parseCosmetic(domains, marker, selector) {
    if (marker !== '##' && marker !== '#@#') throw new Skip('procedural-or-scriptlet');
    var sel = pyStrip(selector);
    if (!sel) throw new Skip('empty-selector');
    if (startsWith(sel, '+js(') || startsWith(sel, '^')) throw new Skip('procedural-or-scriptlet');
    var low = sel.toLowerCase();
    for (var i = 0; i < PROCEDURAL_MARKERS.length; i++) {
      if (low.indexOf(PROCEDURAL_MARKERS[i]) !== -1) throw new Skip('procedural-or-scriptlet');
    }
    if (sel.indexOf('\n') !== -1 || sel.indexOf('\r') !== -1 || !balanced(sel)) throw new Skip('bad-selector');
    var d = pyStrip(domains) ? parseDomainList(domains, ',') : [[], []];
    return [marker === '#@#', d[0], d[1], sel];
  }

  function CosmeticCollector() {
    this.generic = [];
    this.genericSet = new Set();
    this.site = new Map();          // host -> { list, set }
    this.exceptions = new Map();    // host -> Set(selectors)
    this.globalExceptions = new Set();
  }
  CosmeticCollector.prototype.addException = function (h, sel) {
    if (!this.exceptions.has(h)) this.exceptions.set(h, new Set());
    this.exceptions.get(h).add(sel);
  };
  CosmeticCollector.prototype.add = function (exception, inc, exc, sel) {
    var self = this;
    if (exception) {
      if (!inc.length) this.globalExceptions.add(sel);
      inc.forEach(function (h) { self.addException(h, sel); });
      return;
    }
    exc.forEach(function (h) { self.addException(h, sel); });
    if (!inc.length) {
      if (!this.genericSet.has(sel)) { this.genericSet.add(sel); this.generic.push(sel); }
      return;
    }
    inc.forEach(function (h) {
      if (!self.site.has(h)) self.site.set(h, { list: [], set: new Set() });
      var e = self.site.get(h);
      if (!e.set.has(sel)) { e.set.add(sel); e.list.push(sel); }
    });
  };
  CosmeticCollector.prototype.finish = function () {
    var g = this.globalExceptions;
    this.generic = this.generic.filter(function (s) { return !g.has(s); });
    this.genericSet = set(this.generic);
  };

  function headerValue(lines, key) {
    var re = new RegExp('^!\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)$', 'i');
    var n = Math.min(lines.length, 40);
    for (var i = 0; i < n; i++) {
      var m = re.exec(pyStrip(lines[i]));
      if (m) return pyStrip(m[1]);
    }
    return null;
  }

  function siteMap(map) {
    var o = {};
    Array.from(map.keys()).sort(pyCmp).forEach(function (h) { o[h] = map.get(h).list.slice(); });
    return o;
  }

  /**
   * Port of convert_texts() in tools/build_rules.py. texts: { easylist, easyprivacy,
   * 'easylist-cookie' } list texts (all three needed for the site data). Returns
   * { lists: {key: {version, licence, filters, networkConverted, cosmeticConverted, mergedDomains,
   *   duplicates, skipped, skippedTotal, rules}}, site, generic }.
   */
  function convertLists(texts) {
    var out = { lists: {} };
    var cosmetic = { ads: new CosmeticCollector(), cookies: new CosmeticCollector() };
    var generichide = new Set(), elemhide = new Set();
    LISTS.forEach(function (L) {
      var lines = splitLines(texts[L.key] || '');
      var skipped = {};
      var parsed = [];
      var nFilters = 0, nCos = 0;
      lines.forEach(function (line) {
        var c = classify(line);
        if (c[0] === 'comment') return;
        nFilters++;
        try {
          if (c[0] === 'cosmetic') {
            var pc = parseCosmetic(c[1][0], c[1][1], c[1][2]);
            if (L.category === null) throw new Skip('cosmetic-in-network-list');
            cosmetic[L.category].add(pc[0], pc[1], pc[2], pc[3]);
            nCos++;
            return;
          }
          var p = parseNetwork(c[1]);
          if (p.cosmeticException) {
            if (p.cosmeticException.has('elemhide')) elemhide.add(p.host); else generichide.add(p.host);
            nCos++;
            return;
          }
          parsed.push(p);
        } catch (e) {
          if (!(e instanceof Skip)) throw e;
          skipped[e.reason] = (skipped[e.reason] || 0) + 1;
        }
      });
      var built = buildNetworkRules(parsed);
      skipped['regex-cap'] = (skipped['regex-cap'] || 0) + built.stats['regex-cap'];
      var sk = {}, total = 0;
      Object.keys(skipped).sort(pyCmp).forEach(function (k) { sk[k] = skipped[k]; total += skipped[k]; });
      out.lists[L.key] = {
        version: headerValue(lines, 'Version') || headerValue(lines, 'Last modified'),
        licence: headerValue(lines, 'Licence') || headerValue(lines, 'License'),
        filters: nFilters,
        networkConverted: parsed.length,
        cosmeticConverted: nCos,
        mergedDomains: built.stats['merged-domains'],
        duplicates: built.stats.duplicates,
        skipped: sk,
        skippedTotal: total,
        rules: built.rules
      };
    });
    var exceptions = new Map();
    ['ads', 'cookies'].forEach(function (cat) {
      var c = cosmetic[cat];
      c.finish();
      c.exceptions.forEach(function (sels, h) {
        if (!exceptions.has(h)) exceptions.set(h, new Set());
        var t = exceptions.get(h);
        sels.forEach(function (s) { t.add(s); });
      });
    });
    var genericAll = new Set(cosmetic.ads.generic.concat(cosmetic.cookies.generic));
    var excObj = {}, genericExc = [];
    Array.from(exceptions.keys()).sort(pyCmp).forEach(function (h) {
      var sels = Array.from(exceptions.get(h));
      excObj[h] = sels.slice().sort(pyCmp);
      if (sels.some(function (s) { return genericAll.has(s); })) genericExc.push(h);
    });
    out.site = {
      v: 1,
      ads: siteMap(cosmetic.ads.site),
      cookies: siteMap(cosmetic.cookies.site),
      exceptions: excObj,
      genericExceptionHosts: genericExc,
      generichide: Array.from(generichide).sort(pyCmp),
      elemhide: Array.from(elemhide).sort(pyCmp)
    };
    out.generic = { ads: cosmetic.ads.generic.slice(), cookies: cosmetic.cookies.generic.slice() };
    return out;
  }

  ns.filterlist = {
    ALLOW_ID_BASE: ALLOW_ID_BASE,
    DOMAINS_PER_RULE: DOMAINS_PER_RULE,
    MAX_REGEX_RULES_PER_LIST: MAX_REGEX_RULES_PER_LIST,
    LISTS: LISTS,
    Skip: Skip,
    splitLines: splitLines,
    pyStrip: pyStrip,
    pyJson: pyJson,
    punycode: punycode,
    toAsciiHost: toAsciiHost,
    parseDomainList: parseDomainList,
    classify: classify,
    splitOptions: splitOptions,
    isRe2Safe: isRe2Safe,
    parseNetwork: parseNetwork,
    buildNetworkRules: buildNetworkRules,
    isTrackerCookieDomain: isTrackerCookieDomain,
    parseCosmetic: parseCosmetic,
    CosmeticCollector: CosmeticCollector,
    headerValue: headerValue,
    convertLists: convertLists
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
