/*
 * Ad Shield scriptlets: small patches of page APIs that run in the page's own JavaScript world
 * (MAIN) at document_start, before the site's scripts. This project's own code (MIT). The
 * behaviour follows the public descriptions of the filter-syntax scriptlets of the same names
 * (docs/research-v2.md A.1); no code from uBlock Origin, uBO Lite or AdGuard is used.
 *
 * Every scriptlet is fn(win, args, log):
 *   win  - the window to patch (fake objects in tests/scriptlets.test.js); scriptlets only use
 *          win.X, never the globals of this file, so a child frame can be patched too;
 *   args - array of strings from rules/scriptlets.json;
 *   log  - function (scriptletName, message), a no-op in the shipped bundle.
 * A scriptlet never throws into the page: setup errors are caught by the runner and every hook
 * catches its own errors and falls back to the original behaviour.
 * fn.frames = true marks the scriptlets that patch fetch / XMLHttpRequest / JSON / Promise; the
 * runner re-applies them to same-origin child frames (protectFrames), because a page can take a
 * clean fetch from a fresh about:blank iframe before any content script runs there.
 *
 * Path syntax (json-prune*, prune-on-assign): space-separated dotted paths.
 *   a.b.c       delete key c of a.b
 *   a.[].c      [] = every element of an array (or every value of an object)
 *   a.[-].b.c   [-] = remove from array a every element in which b.c is present
 *               (present = not undefined, null or false)
 *   ..a.[-].b   leading .. = apply the rest at every depth of the object (one walk per object)
 * URL / needle arguments: a plain substring, or /regex/flags; empty matches everything.
 */
/* exported asScriptlets */
var asScriptlets = (function () {
  'use strict';

  var nativeParse = JSON.parse;
  var nativeStringify = JSON.stringify;
  var fnToString = Function.prototype.toString;
  var hasOwn = Object.prototype.hasOwnProperty;
  var defineProperty = Object.defineProperty;
  var getOwnDesc = Object.getOwnPropertyDescriptor;
  var reflectApply = Reflect.apply;
  var arraySlice = Array.prototype.slice;
  var noop = function () {};
  var WALK_CAP = 300000; // nodes per deep walk; YouTube's largest responses have far fewer

  function isObj(v) { return v !== null && typeof v === 'object'; }
  function isTrappable(v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); }
  function fnSource(fn) { try { return fnToString.call(fn); } catch (e) { return ''; } }

  // ------------------------------------------------------------------ native look
  // Our wrappers are Proxies of the original function (so name, length and prototype stay), and
  // Function.prototype.toString of each patched realm returns the original's source for them.
  var originals = new WeakMap();
  var toStringDone = new WeakSet();

  function nativeToString(win) {
    try {
      var FP = win && win.Function && win.Function.prototype;
      if (!FP || toStringDone.has(FP)) return;
      toStringDone.add(FP);
      var ts = FP.toString;
      if (typeof ts !== 'function') return;
      var p = new Proxy(ts, {
        apply: function (t, self, a) {
          var o = isTrappable(self) ? originals.get(self) : undefined;
          return reflectApply(t, o !== undefined ? o : self, a);
        }
      });
      originals.set(p, ts);
      defineProperty(FP, 'toString', { value: p, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* leave toString alone */ }
  }

  /** Replace the function owner[key] by a Proxy with the given apply trap. True on success. */
  function wrap(win, owner, key, trap) {
    try {
      if (!isTrappable(owner)) return false;
      var desc = getOwnDesc(owner, key);
      var target = desc ? desc.value : owner[key];
      if (typeof target !== 'function') return false;
      if (desc && !desc.writable && !desc.configurable) return false;
      var proxy = new Proxy(target, { apply: trap });
      originals.set(proxy, target);
      nativeToString(win);
      if (desc) {
        defineProperty(owner, key, { value: proxy, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable });
      } else {
        owner[key] = proxy;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------------ matching
  /** '' -> always true; '/re/flags' -> RegExp test; anything else -> substring. */
  function makeMatcher(pattern) {
    var s = pattern === undefined || pattern === null ? '' : String(pattern);
    if (!s) return function () { return true; };
    var m = /^\/(.+)\/([gimsuy]*)$/.exec(s);
    if (m) {
      try {
        var re = new RegExp(m[1], m[2].replace('g', ''));
        return function (t) { return re.test(String(t)); };
      } catch (e) { /* not a valid regex: treat as text */ }
    }
    return function (t) { return String(t).indexOf(s) !== -1; };
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (isObj(input) && typeof input.url === 'string') return input.url;  // Request
    return String(input);                                              // URL object
  }

  // ------------------------------------------------------------------ property-path traps
  // trapPath(owner, ['a', 'b', 'c'], leaf) makes sure leaf(obj, 'c') runs on whatever object ends
  // up at owner.a.b, now or later: missing or replaced parents are caught by accessors that
  // re-apply the trap to each new value. Several traps can share one parent accessor.
  var subscribers = new WeakMap(); // our getter -> [{ rest, leaf }]

  function descend(v, rest, leaf) { if (isTrappable(v)) trapPath(v, rest, leaf); }

  function trapPath(owner, parts, leaf) {
    try {
      var key = parts[0];
      if (parts.length === 1) { leaf(owner, key); return; }
      var rest = parts.slice(1);
      var desc = getOwnDesc(owner, key);
      if (desc && desc.get && subscribers.has(desc.get)) {
        subscribers.get(desc.get).push({ rest: rest, leaf: leaf });
        descend(desc.get.call(owner), rest, leaf);
        return;
      }
      if (desc && (!desc.configurable || desc.get || desc.set)) {
        // Locked, or someone else's accessor: patch only what is there now.
        descend(owner[key], rest, leaf);
        return;
      }
      var value = desc ? desc.value : undefined;
      var subs = [{ rest: rest, leaf: leaf }];
      var getter = function () { return value; };
      var setter = function (v) {
        value = v;
        for (var i = 0; i < subs.length; i++) descend(v, subs[i].rest, subs[i].leaf);
      };
      subscribers.set(getter, subs);
      descend(value, rest, leaf);
      defineProperty(owner, key, { get: getter, set: setter, enumerable: desc ? desc.enumerable : true, configurable: true });
    } catch (e) { /* this path cannot be trapped */ }
  }

  function defineLeaf(owner, key, get, set) {
    var d = getOwnDesc(owner, key);
    if (d && !d.configurable) return false;
    defineProperty(owner, key, { get: get, set: set, enumerable: d ? d.enumerable : true, configurable: true });
    return true;
  }

  function splitPath(path) {
    var parts = String(path || '').split('.');
    for (var i = 0; i < parts.length; i++) if (!parts[i]) return null;
    return parts;
  }

  /** Value names of set-constant -> { v } or null for an unknown name. */
  function parseValue(s) {
    switch (s) {
      case 'undefined': return { v: undefined };
      case 'false': return { v: false };
      case 'true': return { v: true };
      case 'null': return { v: null };
      case 'noopFunc': return { v: function () {} };
      case 'trueFunc': return { v: function () { return true; } };
      case 'falseFunc': return { v: function () { return false; } };
      case 'emptyObj': return { v: {} };
      case 'emptyArr': return { v: [] };
      case '': case "''": return { v: '' };
      default:
        return /^-?\d{1,9}$/.test(s) ? { v: Number(s) } : null;
    }
  }

  function setConstant(win, args, log) {
    var parts = splitPath(args[0]);
    var pv = parseValue(args[1] === undefined ? 'undefined' : String(args[1]));
    if (!parts || !pv) return;
    trapPath(win, parts, function (owner, key) {
      if (defineLeaf(owner, key, function () { return pv.v; }, noop)) log('set-constant', args[0]);
    });
  }

  function abortError(win) {
    var E = (win && typeof win.ReferenceError === 'function') ? win.ReferenceError : ReferenceError;
    return new E('Permission denied');
  }

  function abortOnRead(win, args) {
    var parts = splitPath(args[0]);
    if (!parts) return;
    trapPath(win, parts, function (owner, key) {
      defineLeaf(owner, key, function () { throw abortError(win); }, noop);
    });
  }

  function abortOnWrite(win, args) {
    var parts = splitPath(args[0]);
    if (!parts) return;
    trapPath(win, parts, function (owner, key) {
      var cur;
      try { cur = owner[key]; } catch (e) { cur = undefined; }
      defineLeaf(owner, key, function () { return cur; }, function () { throw abortError(win); });
    });
  }

  // ------------------------------------------------------------------ JSON pruning
  function compilePaths(s) {
    var out = { plain: [], deep: [] };
    String(s || '').split(/\s+/).forEach(function (p) {
      if (!p) return;
      var deep = p.indexOf('..') === 0;
      var segs = splitPath(deep ? p.slice(2) : p);
      if (segs) (deep ? out.deep : out.plain).push(segs);
    });
    return out;
  }

  function valuesOf(node) {
    if (Array.isArray(node)) return node;
    var out = [];
    for (var k in node) if (hasOwn.call(node, k)) out.push(node[k]);
    return out;
  }

  function present(v) { return v !== undefined && v !== null && v !== false; }

  /** True when segs[i..] lead to a present value under node. */
  function has(node, segs, i) {
    if (i === segs.length) return present(node);
    if (!isObj(node)) return false;
    var seg = segs[i];
    if (seg === '[]' || seg === '[-]') {
      var vals = valuesOf(node);
      for (var j = 0; j < vals.length; j++) if (has(vals[j], segs, i + 1)) return true;
      return false;
    }
    return hasOwn.call(node, seg) && has(node[seg], segs, i + 1);
  }

  /** Remove what segs[i..] point at under node; returns how many keys / elements were removed. */
  function remove(node, segs, i) {
    if (!isObj(node)) return 0;
    var seg = segs[i], last = i === segs.length - 1, n = 0, j;
    if (seg === '[-]') {
      if (last || !Array.isArray(node)) return 0;
      for (j = node.length - 1; j >= 0; j--) {
        if (has(node[j], segs, i + 1)) { node.splice(j, 1); n++; }
      }
      return n;
    }
    if (seg === '[]') {
      if (last) return 0;
      var vals = valuesOf(node);
      for (j = 0; j < vals.length; j++) n += remove(vals[j], segs, i + 1);
      return n;
    }
    if (!hasOwn.call(node, seg)) return 0;
    if (last) {
      try { return delete node[seg] ? 1 : 0; } catch (e) { return 0; } // non-configurable
    }
    return remove(node[seg], segs, i + 1);
  }

  /** Apply the deep paths at every object node of root (iterative, cycle-safe, capped). */
  function walk(root, deep) {
    var n = 0, stack = [root], seen = new Set(), count = 0;
    while (stack.length) {
      var node = stack.pop();
      if (!isObj(node) || seen.has(node)) continue;
      seen.add(node);
      if (++count > WALK_CAP) break;
      for (var d = 0; d < deep.length; d++) n += remove(node, deep[d], 0);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) if (isObj(node[i])) stack.push(node[i]);
      } else {
        for (var k in node) if (hasOwn.call(node, k) && isObj(node[k])) stack.push(node[k]);
      }
    }
    return n;
  }

  function isBracket(seg) { return seg === '[]' || seg === '[-]'; }

  /**
   * The words a JSON text must contain for the paths to remove anything: the last non-bracket
   * segment of each path (every key of a path must be present for a removal). null when some path
   * is brackets only (no word to look for: every text is a candidate).
   */
  function needlesOf(paths) {
    var all = paths.plain.concat(paths.deep), out = [];
    for (var i = 0; i < all.length; i++) {
      var segs = all[i], word = '';
      for (var j = segs.length - 1; j >= 0 && !word; j--) if (!isBracket(segs[j])) word = segs[j];
      if (!word) return null;
      if (out.indexOf(word) === -1) out.push(word);
    }
    return out;
  }

  /**
   * pruner(obj) -> number of things removed. required: paths that must all be present in obj,
   * otherwise nothing is pruned (e.g. "responseContext" for YouTube API responses only).
   * pruner.mayMatch(text): cheap pre-check on a JSON text (plain indexOf of the needle words);
   * false means pruning its parsed value would remove nothing, so callers skip the parse / walk.
   * (Keys written with \u escapes in the text would be missed; YouTube does not write them.)
   */
  function makePruner(props, required) {
    var paths = compilePaths(props), req = compilePaths(required);
    var needles = needlesOf(paths);
    var fn = function (obj) {
      if (!isObj(obj)) return 0;
      try {
        for (var r = 0; r < req.plain.length; r++) if (!has(obj, req.plain[r], 0)) return 0;
        var n = 0;
        for (var i = 0; i < paths.plain.length; i++) n += remove(obj, paths.plain[i], 0);
        if (paths.deep.length) n += walk(obj, paths.deep);
        return n;
      } catch (e) {
        return 0;
      }
    };
    fn.empty = !paths.plain.length && !paths.deep.length;
    fn.mayMatch = function (text) {
      if (!needles) return true;
      try {
        var s = String(text);
        for (var k = 0; k < needles.length; k++) if (s.indexOf(needles[k]) !== -1) return true;
        return false;
      } catch (e) {
        return true;
      }
    };
    return fn;
  }

  // Responses made by pruneResponse: already pruned, so json-prune's Response.json skips them.
  var prunedResponses = new WeakSet();

  function jsonPrune(win, args, log) {
    var prune = makePruner(args[0], args[1]);
    if (prune.empty) return;
    wrap(win, win.JSON, 'parse', function (t, self, a) {
      var r = reflectApply(t, self, a);
      // No needle in the text (and no reviver that could add keys): nothing to remove, no walk.
      if (typeof a[0] === 'string' && typeof a[1] !== 'function' && !prune.mayMatch(a[0])) return r;
      if (isObj(r) && prune(r)) log('json-prune', 'JSON.parse');
      return r;
    });
    var RP = typeof win.Response === 'function' ? win.Response.prototype : null;
    wrap(win, RP, 'json', function (t, self, a) {
      var p = reflectApply(t, self, a);
      try {
        if (prunedResponses.has(self)) return p;
        return p.then(function (o) {
          if (isObj(o) && prune(o)) log('json-prune', 'Response.json');
          return o;
        });
      } catch (e) {
        return p;
      }
    });
  }
  jsonPrune.frames = true;

  /**
   * A pruned copy of a fetch Response (same status, headers, url), or resp itself: untouched (no
   * parse, no copy) when the body has no needle word, is not JSON or loses nothing.
   */
  function pruneResponse(win, resp, prune) {
    try {
      if (!isObj(resp) || typeof resp.clone !== 'function' || resp.bodyUsed) return resp;
      return resp.clone().text().then(function (text) {
        if (!prune.mayMatch(text)) return resp;
        var obj;
        try { obj = nativeParse(text); } catch (e) { return resp; }
        if (!isObj(obj) || !prune(obj)) return resp;
        var out = new win.Response(nativeStringify(obj), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        try { out.headers.delete('content-length'); } catch (e) { /* immutable */ }
        ['url', 'redirected', 'type'].forEach(function (k) {
          try { defineProperty(out, k, { value: resp[k], configurable: true }); } catch (e) { /* keep default */ }
        });
        prunedResponses.add(out);
        return out;
      }, function () { return resp; });
    } catch (e) {
      return resp;
    }
  }

  function jsonPruneFetchResponse(win, args, log) {
    var prune = makePruner(args[0], args[2]);
    var match = makeMatcher(args[1]);
    if (prune.empty || typeof win.Response !== 'function') return;
    wrap(win, win, 'fetch', function (t, self, a) {
      var p = reflectApply(t, self, a);
      try {
        if (!match(urlOf(a[0]))) return p;
        return p.then(function (resp) {
          var out = pruneResponse(win, resp, prune);
          if (out !== resp) log('json-prune-fetch-response', urlOf(a[0]));
          return out;
        });
      } catch (e) {
        return p;
      }
    });
  }
  jsonPruneFetchResponse.frames = true;

  function findDesc(obj, key) {
    for (var o = obj; o; o = Object.getPrototypeOf(o)) {
      var d = getOwnDesc(o, key);
      if (d) return d;
    }
    return null;
  }

  function jsonPruneXhrResponse(win, args, log) {
    var prune = makePruner(args[0], args[2]);
    var match = makeMatcher(args[1]);
    var XP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (prune.empty || !XP) return;
    var rDesc = findDesc(XP, 'response'), tDesc = findDesc(XP, 'responseText');
    if (!rDesc || typeof rDesc.get !== 'function' || !tDesc || typeof tDesc.get !== 'function') return;
    var rGet = rDesc.get, tGet = tDesc.get;
    var cache = new WeakMap(); // xhr -> { raw, out } for the finished response

    function pruned(xhr, raw) {
      try {
        if (xhr.readyState !== 4) return raw;
        var c = cache.get(xhr);
        if (c && c.raw === raw) return c.out;
        var out = raw;
        if (typeof raw === 'string') {
          if (raw && prune.mayMatch(raw)) {
            var o = nativeParse(raw);
            if (isObj(o) && prune(o)) { out = nativeStringify(o); log('json-prune-xhr-response', 'responseText'); }
          }
        } else if (isObj(raw) && xhr.responseType === 'json') {
          if (prune(raw)) log('json-prune-xhr-response', 'response');
        }
        cache.set(xhr, { raw: raw, out: out });
        return out;
      } catch (e) {
        return raw;
      }
    }
    var getResponse = function () { return pruned(this, rGet.call(this)); };
    var getText = function () { return pruned(this, tGet.call(this)); };

    wrap(win, XP, 'open', function (t, xhr, a) {
      try {
        cache.delete(xhr);
        if (match(String(a[1]))) {
          defineProperty(xhr, 'response', { get: getResponse, enumerable: true, configurable: true });
          defineProperty(xhr, 'responseText', { get: getText, enumerable: true, configurable: true });
        } else if (hasOwn.call(xhr, 'responseText')) {
          delete xhr.response;
          delete xhr.responseText;
        }
      } catch (e) { /* plain request */ }
      return reflectApply(t, xhr, a);
    });
  }
  jsonPruneXhrResponse.frames = true;

  /** prune-on-assign(path, props, required): values stored at the path are pruned first. */
  function pruneOnAssign(win, args, log) {
    var parts = splitPath(args[0]);
    var prune = makePruner(args[1], args[2]);
    if (!parts || prune.empty) return;
    trapPath(win, parts, function (owner, key) {
      var value;
      try { value = owner[key]; } catch (e) { value = undefined; }
      if (isObj(value) && prune(value)) log('prune-on-assign', args[0]);
      defineLeaf(owner, key, function () { return value; }, function (v) {
        if (isObj(v) && prune(v)) log('prune-on-assign', args[0]);
        value = v;
      });
    });
  }

  // ------------------------------------------------------------------ requests, timers, promises
  function preventFetch(win, args, log) {
    if (!args[0] || typeof win.Response !== 'function') return;
    var match = makeMatcher(args[0]);
    wrap(win, win, 'fetch', function (t, self, a) {
      try {
        var url = urlOf(a[0]);
        if (url && match(url)) {
          var r = new win.Response('', { status: 200, statusText: 'OK' });
          try { defineProperty(r, 'url', { value: url, configurable: true }); } catch (e) { /* keep '' */ }
          log('prevent-fetch', url);
          return win.Promise.resolve(r);
        }
      } catch (e) { /* send it */ }
      return reflectApply(t, self, a);
    });
  }
  preventFetch.frames = true;

  /** prevent-setTimeout(needle, delay): callbacks whose source matches (and delay equals) never run. */
  function preventSetTimeout(win, args, log) {
    var needle = args[0] ? String(args[0]) : '';
    var delay = args[1] !== undefined && args[1] !== '' ? Number(args[1]) : null;
    if (!needle && delay === null) return; // would stop every timer
    if (delay !== null && isNaN(delay)) return;
    var match = makeMatcher(needle);
    wrap(win, win, 'setTimeout', function (t, self, a) {
      try {
        var fn = a[0];
        var src = typeof fn === 'function' ? fnSource(fn) : String(fn);
        if (match(src) && (delay === null || Number(a[1] || 0) === delay)) {
          log('prevent-setTimeout', String(a[1]));
          a = [noop, a[1]];
        }
      } catch (e) { /* schedule as asked */ }
      return reflectApply(t, self, a);
    });
  }
  preventSetTimeout.frames = true;

  /**
   * adjust-setTimeout(needle, delay, factor): timers whose callback source matches needle (and
   * whose delay equals delay; '' = any) are scheduled with delay * factor (factor clamped to
   * 0.001-50, default 0.05). Not re-applied to child frames: it changes timing, not data, and the
   * YouTube use (the 17 s "fake buffering" wait) runs in the top page.
   */
  function adjustSetTimeout(win, args, log) {
    var match = makeMatcher(args[0]);
    var delay = args[1] !== undefined && args[1] !== '' ? Number(args[1]) : null;
    if (delay !== null && isNaN(delay)) return;
    var factor = args[2] !== undefined && args[2] !== '' ? Number(args[2]) : 0.05;
    if (isNaN(factor)) factor = 0.05;
    factor = Math.min(50, Math.max(0.001, factor));
    wrap(win, win, 'setTimeout', function (t, self, a) {
      try {
        var d = Number(a[1] || 0);
        if (delay === null || d === delay) {
          var fn = a[0];
          var src = typeof fn === 'function' ? fnSource(fn) : String(fn);
          if (match(src)) {
            a = arraySlice.call(a);
            a[1] = d * factor;
            log('adjust-setTimeout', d + ' -> ' + a[1]);
          }
        }
      } catch (e) { /* schedule as asked */ }
      return reflectApply(t, self, a);
    });
  }

  /** prevent-promise-then-callback(needle): then() callbacks whose source matches become no-ops. */
  function preventPromiseThen(win, args, log) {
    if (!args[0]) return;
    var match = makeMatcher(args[0]);
    var P = typeof win.Promise === 'function' ? win.Promise.prototype : null;
    var verdict = new WeakMap();
    function bad(fn) {
      if (typeof fn !== 'function') return false;
      var v = verdict.get(fn);
      if (v === undefined) { v = match(fnSource(fn)); verdict.set(fn, v); }
      return v;
    }
    wrap(win, P, 'then', function (t, self, a) {
      try {
        if (bad(a[0]) || bad(a[1])) {
          a = arraySlice.call(a);
          if (bad(a[0])) a[0] = noop;
          if (bad(a[1])) a[1] = noop;
          log('prevent-promise-then-callback', String(args[0]));
        }
      } catch (e) { /* pass through */ }
      return reflectApply(t, self, a);
    });
  }
  preventPromiseThen.frames = true;

  // ------------------------------------------------------------------ DOM attribute / class removal
  /**
   * Runs fix(doc) at DOMContentLoaded and again (throttled to one run per 100 ms) on DOM changes,
   * until 3 s after load or 10 s after start, whichever comes first. Then the observer is gone.
   */
  function domFixer(win, fix, attributeFilter) {
    var doc = win.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    var pending = false, mo = null, stopped = false;
    function run() {
      pending = false;
      if (stopped && mo === null) return;
      try { fix(doc); } catch (e) { /* bad selector or detached */ }
    }
    function stop() {
      stopped = true;
      if (mo) { mo.disconnect(); mo = null; }
    }
    function start() {
      run();
      if (typeof win.MutationObserver !== 'function' || stopped) return;
      mo = new win.MutationObserver(function () {
        if (!pending) { pending = true; win.setTimeout(run, 100); }
      });
      mo.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true, attributeFilter: attributeFilter });
      win.setTimeout(stop, 10000);
      if (doc.readyState === 'complete') win.setTimeout(stop, 3000);
      else win.addEventListener('load', function () { win.setTimeout(stop, 3000); }, { once: true });
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  function names(s, re) {
    return String(s || '').split(/[\s|]+/).filter(function (x) { return x && re.test(x); });
  }

  function removeAttr(win, args, log) {
    var attrs = names(args[0], /^[A-Za-z_:][-\w:.]*$/);
    if (!attrs.length) return;
    var sel = args[1] ? String(args[1]) : attrs.map(function (a) { return '[' + a + ']'; }).join(',');
    domFixer(win, function (doc) {
      var els = doc.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        for (var j = 0; j < attrs.length; j++) {
          if (els[i].hasAttribute(attrs[j])) { els[i].removeAttribute(attrs[j]); log('remove-attr', attrs[j]); }
        }
      }
    }, attrs);
  }

  function removeClass(win, args, log) {
    var classes = names(args[0], /^-?[_a-zA-Z][-\w]*$/);
    if (!classes.length) return;
    var sel = args[1] ? String(args[1]) : classes.map(function (c) { return '.' + c; }).join(',');
    domFixer(win, function (doc) {
      var els = doc.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        for (var j = 0; j < classes.length; j++) {
          if (els[i].classList.contains(classes[j])) { els[i].classList.remove(classes[j]); log('remove-class', classes[j]); }
        }
      }
    }, ['class']);
  }

  // ------------------------------------------------------------------ YouTube in-stream fallback
  /**
   * youtube-ad-skip: when a player (.html5-video-player, e.g. #movie_player) gets the class
   * ad-showing, mute its video, jump to the end of the ad and click the skip button if present;
   * unmute afterwards if we muted. Event-driven: one capture listener for loadedmetadata/playing
   * on the document finds each player once and puts one MutationObserver on its class attribute.
   * The observer runs on every class change (ytp-autohide on each mouse move, ...), so the seek
   * happens at most once per ad (per video src + duration; forgotten when ad-showing clears):
   * repeated seeks into an MSE stream stall the player. No seek when the ad is longer than
   * MAX_SEEK_AD s (almost always a stitched stream whose end is the end of the real video;
   * skippable long ads get the Skip click) or part of the content stream (SSAP: same video src as
   * the content, or the player's debug info says SSAP; getStatsForNerds is asked only right
   * before a seek, once per ad), because the stream's end is the end of the video.
   */
  var SKIP_BUTTONS = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button';
  var MAX_SEEK_AD = 90; // s; longer "ads" are stitched streams, never seeked

  function youtubeAdSkip(win, args, log) {
    var doc = win.document;
    if (!doc || typeof doc.addEventListener !== 'function' || typeof win.MutationObserver !== 'function') return;
    var checks = new WeakMap();

    function isSsap(player) {
      try {
        var s = typeof player.getStatsForNerds === 'function' ? player.getStatsForNerds() : null;
        return !!(s && typeof s.debug_info === 'string' && s.debug_info.indexOf('SSAP') === 0);
      } catch (e) {
        return false;
      }
    }

    function attach(player) {
      var c = checks.get(player);
      if (c) return c;
      var mutedByUs = false, contentSrc = '', handled = ''; // handled: src|duration of the ad already seeked (or found SSAP)
      c = function () {
        try {
          var v = player.querySelector('video');
          if (!player.classList.contains('ad-showing')) {
            if (v && v.src) contentSrc = v.src;
            handled = '';
            if (mutedByUs) { mutedByUs = false; if (v && v.muted) v.muted = false; }
            return;
          }
          if (v) {
            if (!v.muted) { v.muted = true; mutedByUs = true; }
            var d = v.duration, ad = v.src + '|' + d;
            // cheap checks first; the player's debug info only right before a seek
            if (ad !== handled && isFinite(d) && d > 0 && d <= MAX_SEEK_AD && v.currentTime < d - 0.25 &&
                !(contentSrc && v.src === contentSrc)) {
              handled = ad;
              if (!isSsap(player)) {
                v.currentTime = d;
                log('youtube-ad-skip', 'seek');
              }
            }
          }
          var b = player.querySelector(SKIP_BUTTONS);
          if (b && typeof b.click === 'function') { b.click(); log('youtube-ad-skip', 'skip button'); }
        } catch (e) { /* leave the player alone */ }
      };
      checks.set(player, c);
      new win.MutationObserver(c).observe(player, { attributes: true, attributeFilter: ['class'] });
      return c;
    }

    function onMedia(e) {
      try {
        var t = e.target;
        if (!t || t.tagName !== 'VIDEO' || typeof t.closest !== 'function') return;
        var player = t.closest('.html5-video-player');
        if (player) attach(player)();
      } catch (err) { /* not a player */ }
    }
    doc.addEventListener('loadedmetadata', onMedia, true);
    doc.addEventListener('playing', onMedia, true);
  }

  // ------------------------------------------------------------------ YouTube anti-adblock dialog
  /**
   * youtube-enforcement-dismiss: YouTube's anti-adblock dialog (ytd-enforcement-message-view-model
   * inside a modal tp-yt-paper-dialog) locks page scrolling and pauses the video while it is open.
   * Hiding it with CSS leaves all of that in place, so this closes it instead: close() on the
   * dialog (Polymer then releases its scroll lock and backdrop; remove() if there is no close()),
   * close any opened tp-yt-iron-overlay-backdrop, clear overflow:hidden on html / body and the
   * no-scroll attribute / class on html / body / ytd-app. While the dialog is open, or within
   * RESUME_AFTER_CLOSE ms after we last found it open (and closed it), a player video that pauses
   * without user activation (not ended, not seeking, readyState >= 3 HAVE_FUTURE_DATA, no ad
   * showing) is resumed, at most RESUME_MAX times per RESUME_WINDOW ms so we never fight the page
   * in a loop. Other pauses are the player's own (source / quality switches, ad -> content,
   * seeks, buffering) and are left alone: resuming those desynchronised audio and video.
   * Event-driven: a capture listener for animationstart (rules/cosmetic/youtube.css gives the
   * element a 1 ms animation 'as-yt-enf') and one for pause (also finds the dialog when the CSS
   * hook is missing). No MutationObserver, no timers except one delayed re-check of the lock.
   * Pauses within MEDIA_ACTION_GRACE ms of a navigator.mediaSession action handler call (media
   * keys, headphones, picture-in-picture) are the viewer's and are not resumed.
   */
  var ENFORCEMENT = 'ytd-enforcement-message-view-model';
  var ENFORCEMENT_ANIMATION = 'as-yt-enf';
  var RESUME_MAX = 3;
  var RESUME_WINDOW = 10000;
  var RESUME_AFTER_CLOSE = 3000; // ms after we last found the dialog open: its pauses may still come
  var MEDIA_ACTION_GRACE = 1500; // ms after a media-session action in which a pause is the viewer's

  function youtubeEnforcementDismiss(win, args, log) {
    var doc = win.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    var seen = false;
    var lastOpen = -Infinity; // when handle() last found the dialog open
    var resumes = [];

    function now() {
      try { return win.Date && typeof win.Date.now === 'function' ? win.Date.now() : Date.now(); } catch (e) { return Date.now(); }
    }

    function unlock() {
      try {
        [doc.documentElement, doc.body].forEach(function (el) {
          var s = el && el.style;
          if (!s) return;
          if (s.overflow === 'hidden') s.overflow = '';
          if (s.overflowY === 'hidden') s.overflowY = '';
        });
        [doc.documentElement, doc.body, doc.querySelector('ytd-app')].forEach(function (el) {
          if (!el) return;
          if (typeof el.hasAttribute === 'function' && el.hasAttribute('no-scroll')) el.removeAttribute('no-scroll');
          if (el.classList && el.classList.contains('no-scroll')) el.classList.remove('no-scroll');
        });
      } catch (e) { /* leave the page alone */ }
    }

    function closeBackdrops() {
      try {
        var list = doc.querySelectorAll('tp-yt-iron-overlay-backdrop');
        for (var i = 0; i < list.length; i++) {
          var b = list[i];
          if (!(b.opened === true || (b.classList && b.classList.contains('opened')))) continue;
          if (typeof b.close === 'function') b.close();
          else if (typeof b.remove === 'function') b.remove();
        }
      } catch (e) { /* leave it */ }
    }

    function dialogOf(enf) {
      try {
        return typeof enf.closest === 'function' ? enf.closest('tp-yt-paper-dialog') : null;
      } catch (e) {
        return null;
      }
    }

    /** Close the dialog around enf if it is open; true when something was closed. */
    function closeDialog(enf) {
      try {
        var dlg = dialogOf(enf);
        if (!dlg || dlg.opened === false) return false;
        if (typeof dlg.close === 'function') dlg.close();
        else if (typeof dlg.remove === 'function') dlg.remove();
        else return false;
        log('youtube-enforcement-dismiss', 'dialog closed');
        return true;
      } catch (e) {
        return false;
      }
    }

    function handle(enf) {
      try {
        if (!enf) return;
        var first = !seen;
        seen = true;
        var dlg = dialogOf(enf);
        if (dlg && dlg.opened !== false) lastOpen = now(); // also when close() fails: still open
        if (closeDialog(enf) || first) {
          closeBackdrops();
          unlock();
          // Polymer may finish closing asynchronously; check the lock once more.
          if (typeof win.setTimeout === 'function') win.setTimeout(unlock, 500);
        }
      } catch (e) { /* leave the page alone */ }
    }

    // Media keys, headphones and picture-in-picture buttons reach the page through
    // navigator.mediaSession action handlers, without user activation: note when one runs, so the
    // pause it causes is the viewer's and is not undone.
    var lastMediaAction = -Infinity;
    var MEDIA_ACTIONS = { pause: 1, play: 1, stop: 1, seekto: 1, previoustrack: 1, nexttrack: 1 };
    try {
      var ms = win.navigator && win.navigator.mediaSession;
      if (isObj(ms)) {
        var proto = Object.getPrototypeOf(ms);
        var owner = proto && hasOwn.call(proto, 'setActionHandler') ? proto : ms;
        wrap(win, owner, 'setActionHandler', function (t, self, a) {
          try {
            var handler = a[1];
            if (typeof handler === 'function' && hasOwn.call(MEDIA_ACTIONS, String(a[0]))) {
              a = arraySlice.call(a);
              a[1] = function () {
                lastMediaAction = now();
                return reflectApply(handler, this, arguments);
              };
            }
          } catch (e) { /* register as asked */ }
          return reflectApply(t, self, a);
        });
      }
    } catch (e) { /* no media session */ }

    function resume(v, player) {
      if (now() - lastOpen >= RESUME_AFTER_CLOSE) return; // no enforcement dialog open / just closed
      if (v.ended || v.seeking || !(v.readyState >= 3)) return; // the player's own pause
      if (player.classList && player.classList.contains('ad-showing')) return;
      if (now() - lastMediaAction < MEDIA_ACTION_GRACE) return; // media key / headphones / PiP
      var nav = win.navigator;
      var ua = nav && nav.userActivation;
      if (!ua || ua.isActive) return; // a user pause (click, space, k), or we cannot tell
      var t = now();
      resumes = resumes.filter(function (x) { return t - x < RESUME_WINDOW; });
      if (resumes.length >= RESUME_MAX) { log('youtube-enforcement-dismiss', 'resume throttled'); return; }
      resumes.push(t);
      var p = v.play();
      if (p && typeof p.then === 'function') p.then(noop, noop);
      log('youtube-enforcement-dismiss', 'resumed');
    }

    doc.addEventListener('animationstart', function (e) {
      try {
        if (e && e.animationName === ENFORCEMENT_ANIMATION) handle(e.target);
      } catch (err) { /* not ours */ }
    }, true);

    doc.addEventListener('pause', function (e) {
      try {
        var v = e && e.target;
        if (!v || v.tagName !== 'VIDEO' || typeof v.closest !== 'function') return;
        var player = v.closest('.html5-video-player');
        if (!player) return;
        handle(doc.querySelector(ENFORCEMENT));
        resume(v, player);
      } catch (err) { /* leave the video alone */ }
    }, true);
  }

  // ------------------------------------------------------------------ child frames
  /**
   * Call onFrame(childWindow) once per document of every same-origin iframe the page reaches via
   * iframe.contentWindow / contentDocument, so the page cannot take an unpatched fetch / JSON /
   * Promise from a fresh about:blank frame. Cross-origin frames throw on .document and are skipped
   * (our content script runs in them itself). Not covered: window.frames[i] / window[i] access.
   */
  function protectFrames(win, onFrame) {
    try {
      var IFP = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
      if (!IFP) return;
      var done = new WeakSet();
      var check = function (w) {
        try {
          if (!w) return;
          var d = w.document;
          if (!isObj(d) || done.has(d)) return;
          done.add(d);
          onFrame(w);
        } catch (e) { /* cross-origin */ }
      };
      ['contentWindow', 'contentDocument'].forEach(function (prop) {
        var desc = getOwnDesc(IFP, prop);
        if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
        var getter = new Proxy(desc.get, {
          apply: function (t, self, a) {
            var r = reflectApply(t, self, a);
            check(prop === 'contentWindow' ? r : (r && r.defaultView));
            return r;
          }
        });
        originals.set(getter, desc.get);
        nativeToString(win);
        defineProperty(IFP, prop, { get: getter, set: desc.set, enumerable: desc.enumerable, configurable: true });
      });
    } catch (e) { /* frames stay unpatched */ }
  }

  return {
    scriptlets: {
      'set-constant': setConstant,
      'abort-on-property-read': abortOnRead,
      'abort-on-property-write': abortOnWrite,
      'json-prune': jsonPrune,
      'json-prune-fetch-response': jsonPruneFetchResponse,
      'json-prune-xhr-response': jsonPruneXhrResponse,
      'prune-on-assign': pruneOnAssign,
      'prevent-fetch': preventFetch,
      'prevent-setTimeout': preventSetTimeout,
      'adjust-setTimeout': adjustSetTimeout,
      'prevent-promise-then-callback': preventPromiseThen,
      'remove-attr': removeAttr,
      'remove-class': removeClass,
      'youtube-ad-skip': youtubeAdSkip,
      'youtube-enforcement-dismiss': youtubeEnforcementDismiss
    },
    protectFrames: protectFrames,
    makePruner: makePruner,
    makeMatcher: makeMatcher,
    parseValue: parseValue
  };
})();
