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
  // Our wrappers are Proxies of the original function (so name, length and prototype stay). Each
  // gets a non-enumerable own toString, a bound Function.prototype.toString of the original:
  // fn.toString() / String(fn) show the original source and the toString itself looks native.
  // Nothing realm-wide (no Function.prototype.toString hook: that cost every toString call).
  var originals = new WeakMap(); // our wrapper -> the function it replaced (first original)

  function lookNative(proxy, target) {
    try {
      var orig = originals.get(target) || target;
      originals.set(proxy, orig);
      // No defineProperty trap: this lands on the target, which only our proxy still exposes.
      defineProperty(proxy, 'toString', { value: fnToString.bind(orig), writable: true, enumerable: false, configurable: true });
    } catch (e) { /* frozen target: keep the default toString */ }
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
      lookNative(proxy, target);
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
   * The word a JSON text must contain for a path to remove anything: its last non-bracket segment
   * (every key of a path must be present for a removal). '' when the path is brackets only.
   */
  function needleOf(segs) {
    for (var j = segs.length - 1; j >= 0; j--) if (!isBracket(segs[j])) return segs[j];
    return '';
  }

  /** All needle words of the paths; null when some path has none (every text is a candidate). */
  function needlesOf(paths) {
    var all = paths.plain.concat(paths.deep), out = [];
    for (var i = 0; i < all.length; i++) {
      var word = needleOf(all[i]);
      if (!word) return null;
      if (out.indexOf(word) === -1) out.push(word);
    }
    return out;
  }

  /**
   * pruner(obj, text) -> number of things removed. required: paths that must all be present in
   * obj, otherwise nothing is pruned. text (optional): the JSON text obj was parsed from; a deep
   * (..) path then walks obj only when its own needle word is in the text (plain paths are a few
   * key lookups and always run).
   * pruner.mayMatch(text): cheap pre-check on a JSON text (plain indexOf of the needle words);
   * false means pruning its parsed value would remove nothing, so callers skip the parse / walk.
   * (Keys written with \u escapes in the text would be missed; YouTube does not write them.)
   */
  function makePruner(props, required) {
    var paths = compilePaths(props), req = compilePaths(required);
    var needles = needlesOf(paths);
    var deepNeedles = paths.deep.map(needleOf);
    function deepFor(text) {
      if (typeof text !== 'string') return paths.deep;
      var out = [];
      for (var d = 0; d < paths.deep.length; d++) {
        if (!deepNeedles[d] || text.indexOf(deepNeedles[d]) !== -1) out.push(paths.deep[d]);
      }
      return out;
    }
    var fn = function (obj, text) {
      if (!isObj(obj)) return 0;
      try {
        for (var r = 0; r < req.plain.length; r++) if (!has(obj, req.plain[r], 0)) return 0;
        var n = 0;
        for (var i = 0; i < paths.plain.length; i++) n += remove(obj, paths.plain[i], 0);
        if (paths.deep.length) {
          var deep = deepFor(text);
          if (deep.length) n += walk(obj, deep);
        }
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
      if (!isObj(r)) return r;
      // No needle in the text (and no reviver that could add keys): nothing to remove, no walk.
      var text = typeof a[0] === 'string' && typeof a[1] !== 'function' ? a[0] : undefined;
      if (text !== undefined && !prune.mayMatch(text)) return r;
      if (prune(r, text)) log('json-prune', 'JSON.parse');
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
        if (!isObj(obj) || !prune(obj, text)) return resp;
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
            if (isObj(o) && prune(o, raw)) { out = nativeStringify(o); log('json-prune-xhr-response', 'responseText'); }
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

  /**
   * edit-request-body(url, needle, edit...): JSON request bodies of matching fetch / XHR requests
   * are edited before they are sent. needle: a top-level key the body must have (also a plain
   * indexOf pre-check on the text). Each edit is one of
   *   path==<json>   condition: nothing is edited unless every condition holds;
   *   path=<json>    set the value (the parent object must exist; nothing is created);
   *   path+=<text>   append text to the string at path unless it already ends with it.
   * Paths are dotted (a.b.c). A body is re-serialised only when an edit changed something.
   * Bodies handled: a string fetch init.body or XMLHttpRequest.send(string), and a POST Request
   * passed to fetch (read from a clone; gzip bodies (Content-Encoding: gzip, what YouTube sends)
   * are gunzipped and gzipped again with the page's DecompressionStream / CompressionStream, and
   * sent untouched where those are missing). Everything else, and every non-matching URL, goes out
   * as it came after one URL test. No JSON.stringify or Promise hook.
   */
  function compileEdits(list) {
    var out = { conds: [], sets: [], appends: [] };
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i]), m, parts;
      try {
        if ((m = /^([^=+]+)==([\s\S]*)$/.exec(s))) {
          parts = splitPath(m[1]); if (!parts) return null;
          out.conds.push({ parts: parts, value: nativeParse(m[2]) });
        } else if ((m = /^([^=+]+)\+=([\s\S]+)$/.exec(s))) {
          parts = splitPath(m[1]); if (!parts) return null;
          out.appends.push({ parts: parts, text: m[2] });
        } else if ((m = /^([^=+]+)=([\s\S]*)$/.exec(s))) {
          parts = splitPath(m[1]); if (!parts) return null;
          out.sets.push({ parts: parts, value: nativeParse(m[2]) });
        } else {
          return null;
        }
      } catch (e) {
        return null; // value is not JSON
      }
    }
    return out.sets.length || out.appends.length ? out : null;
  }

  function getAt(obj, parts, n) {
    var o = obj;
    for (var i = 0; i < n; i++) {
      if (!isObj(o) || !hasOwn.call(o, parts[i])) return undefined;
      o = o[parts[i]];
    }
    return o;
  }

  function sameJson(a, b) {
    if (a === b) return true;
    if (!isObj(a) || !isObj(b)) return false;
    try { return nativeStringify(a) === nativeStringify(b); } catch (e) { return false; }
  }

  /** Edit obj in place; the number of values changed (0 when a condition fails). */
  function applyEdits(obj, needle, edits) {
    if (!isObj(obj) || !hasOwn.call(obj, needle)) return 0;
    var i, e, parent, key, n = 0;
    for (i = 0; i < edits.conds.length; i++) {
      e = edits.conds[i];
      if (!sameJson(getAt(obj, e.parts, e.parts.length), e.value)) return 0;
    }
    for (i = 0; i < edits.sets.length; i++) {
      e = edits.sets[i];
      parent = getAt(obj, e.parts, e.parts.length - 1);
      key = e.parts[e.parts.length - 1];
      if (isObj(parent) && !sameJson(parent[key], e.value)) { parent[key] = e.value; n++; }
    }
    for (i = 0; i < edits.appends.length; i++) {
      e = edits.appends[i];
      parent = getAt(obj, e.parts, e.parts.length - 1);
      key = e.parts[e.parts.length - 1];
      if (isObj(parent) && hasOwn.call(parent, key) && typeof parent[key] === 'string') {
        var v = parent[key];
        if (v.length < e.text.length || v.slice(v.length - e.text.length) !== e.text) { parent[key] = v + e.text; n++; }
      }
    }
    return n;
  }

  function editRequestBody(win, args, log) {
    var match = makeMatcher(args[0]);
    var needle = args[1] ? String(args[1]) : '';
    var edits = compileEdits(arraySlice.call(args, 2));
    if (!args[0] || !needle || !edits) return;

    /** The edited text, or null when the body stays as it is. */
    function editText(text, url) {
      if (typeof text !== 'string' || text.indexOf(needle) === -1) return null;
      var obj;
      try { obj = nativeParse(text); } catch (e) { return null; }
      if (!applyEdits(obj, needle, edits)) return null;
      log('edit-request-body', url);
      return nativeStringify(obj);
    }

    function viaCodec(Ctor, body) { // body (string / bytes) through a gzip (de)compression stream
      return new win.Response(new win.Response(body).body.pipeThrough(new Ctor('gzip')));
    }

    /** Promise of the Request to send: an edited copy of req, or req itself. */
    function editRequest(req, url) {
      var enc = '';
      try { enc = String(req.headers.get('content-encoding') || '').toLowerCase(); } catch (e) { /* none */ }
      var gzip = enc === 'gzip';
      if ((enc && !gzip) || (gzip && (typeof win.DecompressionStream !== 'function' || typeof win.CompressionStream !== 'function'))) {
        return win.Promise.resolve(req);
      }
      var copy = req.clone();
      var textP = gzip ? viaCodec(win.DecompressionStream, copy.body).text() : copy.text();
      return textP.then(function (text) {
        var out = editText(text, url);
        if (out === null) return req;
        var bodyP = gzip ? viaCodec(win.CompressionStream, out).arrayBuffer() : win.Promise.resolve(out);
        return bodyP.then(function (body) { return new win.Request(req, { body: body }); });
      }).then(null, function () { return req; });
    }

    wrap(win, win, 'fetch', function (t, self, a) {
      try {
        var url = urlOf(a[0]);
        if (!match(url)) return reflectApply(t, self, a);
        var init = a[1];
        if (isObj(init) && init.body !== undefined && init.body !== null) {
          var out = editText(init.body, url);
          if (out !== null) {
            var copy = {};
            for (var k in init) copy[k] = init[k];
            copy.body = out;
            a = [a[0], copy];
          }
          return reflectApply(t, self, a);
        }
        var req = a[0];
        if (isObj(req) && typeof req.clone === 'function' && typeof win.Request === 'function' &&
            String(req.method).toUpperCase() === 'POST' && req.body !== null && !req.bodyUsed) {
          var rest = arraySlice.call(a, 1);
          return editRequest(req, url).then(function (r) {
            return reflectApply(t, self, [r].concat(rest));
          });
        }
      } catch (e) { /* send it as it came */ }
      return reflectApply(t, self, a);
    });

    var XP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (!XP) return;
    var pending = new WeakMap(); // xhr -> url of the matching request opened on it
    wrap(win, XP, 'open', function (t, xhr, a) {
      try {
        var url = String(a[1]);
        if (match(url)) pending.set(xhr, url); else pending.delete(xhr);
      } catch (e) { /* plain request */ }
      return reflectApply(t, xhr, a);
    });
    wrap(win, XP, 'send', function (t, xhr, a) {
      try {
        var url = pending.get(xhr);
        if (url !== undefined && typeof a[0] === 'string') {
          var out = editText(a[0], url);
          if (out !== null) a = [out];
        }
      } catch (e) { /* send it as it came */ }
      return reflectApply(t, xhr, a);
    });
  }
  editRequestBody.frames = true;

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
        // The delay first: the callback's source is read only for a matching delay.
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

  /**
   * prevent-promise-then-callback(needle): then() callbacks whose source matches become no-ops.
   * Kept in the library but used by no rule since 2.0: a hook on every Promise.prototype.then
   * call costs frames on YouTube.
   */
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

  // ------------------------------------------------------------------ anti-bypass
  /**
   * prevent-dom-bypass(method, props): after the DOM method at the dotted path `method` (e.g.
   * Node.prototype.appendChild) inserts a node, every same-origin iframe in what was inserted gets
   * this window's current value of each of `props` (space-separated, e.g. "fetch Request"), so
   * the page cannot take a clean fetch / Request from a freshly appended frame, however it then
   * reaches the frame's window (contentWindow, window.frames[i], window[i]). The values are read
   * at call time, so they are whatever our other scriptlets made of them. Fragments are searched
   * before the call (they are empty afterwards), elements after it (an iframe has a window only
   * once it is connected). Cross-origin frames throw and are skipped. (uBO's
   * trusted-prevent-dom-bypass, uAssets quick-fixes.txt.)
   */
  function preventDomBypass(win, args, log) {
    var parts = splitPath(args[0]);
    var props = names(args[1], /^[A-Za-z_$][\w$]*$/);
    if (!parts || parts.length < 2 || !props.length) return;
    var owner = win;
    try {
      for (var i = 0; i < parts.length - 1 && isTrappable(owner); i++) owner = owner[parts[i]];
    } catch (e) { return; }
    var key = parts[parts.length - 1];

    function framesIn(node, before) {
      if (!isObj(node)) return null;
      if (node.nodeName === 'IFRAME') return before ? null : [node];
      if (node.nodeType === 11) {         // DocumentFragment: its children move out on insertion
        return before && typeof node.querySelectorAll === 'function' ? node.querySelectorAll('iframe') : null;
      }
      if (node.nodeType !== 1 || before || typeof node.getElementsByTagName !== 'function') return null;
      return node.getElementsByTagName('iframe');
    }

    function patch(list) {
      for (var i = 0; list && i < list.length; i++) {
        var w;
        try { w = list[i].contentWindow; } catch (e) { continue; }
        if (!w || w === win) continue;
        for (var j = 0; j < props.length; j++) {
          try {
            var v = win[props[j]];
            if (v !== undefined && w[props[j]] !== v) { w[props[j]] = v; log('prevent-dom-bypass', props[j]); }
          } catch (e) { /* cross-origin frame */ }
        }
      }
    }

    wrap(win, owner, key, function (t, self, a) {
      var early = null;
      try { early = framesIn(a[0], true); } catch (e) { early = null; }
      var r = reflectApply(t, self, a);
      try { patch(early || framesIn(a[0], false)); } catch (e) { /* leave the frame alone */ }
      return r;
    });
  }

  /**
   * remove-node-text(nodeName, needle): elements named nodeName (e.g. script) whose text matches
   * needle (substring or /regex/) are emptied and removed as the parser adds them, before an
   * inline script runs (the parser empties the microtask queue, and so delivers our
   * MutationObserver records, before it runs a script; a removed script does not run). Also
   * catches script text that arrives after its element (text node records). Watches the
   * document until DOMContentLoaded only: every parser-inserted element is in by then, and a
   * script added later by script code runs synchronously, out of an observer's reach.
   * (uBO's rmnt / remove-node-text, uAssets quick-fixes.txt: rmnt, script, 'window,"fetch"'.)
   */
  function removeNodeText(win, args, log) {
    var tag = String(args[0] || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(tag) || !args[1]) return;
    var match = makeMatcher(args[1]);
    var doc = win.document;
    if (!doc || typeof win.MutationObserver !== 'function' || typeof doc.addEventListener !== 'function') return;
    if (doc.readyState && doc.readyState !== 'loading') return; // too late: the parser is done

    function check(el) {
      try {
        if (!el || el.nodeName !== tag || !match(el.textContent)) return;
        el.textContent = '';
        if (el.parentNode) el.parentNode.removeChild(el);
        log('remove-node-text', tag.toLowerCase());
      } catch (e) { /* leave it */ }
    }

    function onRecords(muts) {
      for (var i = 0; muts && i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; added && j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) check(n);
          else if (n.nodeType === 3) check(n.parentNode);
        }
      }
    }
    var mo = new win.MutationObserver(onRecords);
    mo.observe(doc, { childList: true, subtree: true });
    doc.addEventListener('DOMContentLoaded', function () {
      try { if (typeof mo.takeRecords === 'function') onRecords(mo.takeRecords()); } catch (e) { /* none */ }
      mo.disconnect();
    }, { once: true });
  }

  // ------------------------------------------------------------------ YouTube player events
  /**
   * youtube-drop-player-event(events): the YouTube player's own events named in `events`
   * (space-separated, e.g. onAbnormalityDetected) never reach the page's listeners.
   * How the player does it (base.js and ytmainappweb kevlar_base, read 2026-11-22): the player
   * keeps its API in an object of arrow functions and copies it onto its element (div
   * #movie_player) with plain assignments (element[name] = fn), getApiInterface and
   * addEventListener among them; the main app subscribes with
   * player.addEventListener('onAbnormalityDetected', cb), directly or through its PlayerProxy,
   * which calls the element's addEventListener. The player publishes onAbnormalityDetected
   * when it thinks it is being tampered with (an ad context in the SABR stream for a response
   * without a pre-roll, an untrusted click on Skip, an ad that finished too fast), and the
   * callback stops the video and shows the enforcement message (playabilityStatus ERROR with an
   * enforcementMessageViewModel, or the LOCKED_MODAL popup).
   * Here: an accessor for getApiInterface on HTMLElement.prototype (a name no standard element
   * has) notices that copy, stores the value as the element's own property, and gives that one
   * element an addEventListener accessor that wraps whatever the player assigns: subscriptions
   * to the named events are dropped, everything else goes through. Other elements are not
   * touched; no Promise.prototype.then hook (uBO neuters then() callbacks whose source mentions
   * onAbnormalityDetected instead).
   */
  var PLAYER_API_MARKER = 'getApiInterface';

  function youtubeDropPlayerEvent(win, args, log) {
    var events = names(args[0], /^[A-Za-z][\w-]*$/);
    var HP = win.HTMLElement && win.HTMLElement.prototype;
    if (!events.length || !isObj(HP) || getOwnDesc(HP, PLAYER_API_MARKER)) return;

    function guard(fn) {
      if (typeof fn !== 'function') return fn;
      var p = new Proxy(fn, {
        apply: function (t, self, a) {
          try {
            if (events.indexOf(String(a[0])) !== -1) { log('youtube-drop-player-event', String(a[0])); return undefined; }
          } catch (e) { /* subscribe as asked */ }
          return reflectApply(t, self, a);
        }
      });
      lookNative(p, fn);
      return p;
    }

    function guardPlayer(el) {
      var d = getOwnDesc(el, 'addEventListener');
      if (d && (d.get || d.set || !d.configurable)) return; // ours already, or not ours to change
      var stored = d ? guard(d.value) : undefined;
      var getter = function () {
        if (stored !== undefined) return stored;
        var proto = Object.getPrototypeOf(el);
        return proto ? proto.addEventListener : undefined; // the DOM method until the player copies its own
      };
      defineProperty(el, 'addEventListener', {
        get: getter,
        set: function (v) { stored = guard(v); },
        enumerable: true,
        configurable: true
      });
    }

    defineProperty(HP, PLAYER_API_MARKER, {
      get: function () { return undefined; },
      set: function (v) {
        try {
          defineProperty(this, PLAYER_API_MARKER, { value: v, writable: true, enumerable: true, configurable: true });
          if (this !== HP && isObj(this)) { guardPlayer(this); log('youtube-drop-player-event', 'player found'); }
        } catch (e) { /* leave the element alone */ }
      },
      enumerable: false,
      configurable: true
    });
  }

  // ------------------------------------------------------------------ YouTube in-stream fallback
  /**
   * youtube-ad-skip: when a player (.html5-video-player, e.g. #movie_player) gets the class
   * ad-showing, mute its video and jump to the end of the ad; unmute afterwards if we muted.
   * The Skip button is never clicked: the player checks event.isTrusted on a Skip click and, for
   * a script's click, does not skip but publishes onAbnormalityDetected (the enforcement
   * trigger) and reports a detection (base.js, read 2026-11-22; up to 2.0 this clicked it). Event-driven: one capture listener for loadedmetadata/playing
   * on the document finds each player once and puts one MutationObserver on its class attribute.
   * The observer runs on every class change (ytp-autohide on each mouse move, ...), so the seek
   * happens at most once per ad (per video src + duration; forgotten when ad-showing clears):
   * repeated seeks into an MSE stream stall the player. No seek when the ad is longer than
   * MAX_SEEK_AD s (almost always a stitched stream whose end is the end of the real video) or part of the content stream (SSAP: same video src as
   * the content, or the player's debug info says SSAP; getStatsForNerds is asked only right
   * before a seek, once per ad), because the stream's end is the end of the video.
   */
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

  // ------------------------------------------------------------------ YouTube blocked-playback screen
  /**
   * youtube-playability-recover: YouTube's blocked-playback screen ("Ad blockers violate YouTube's
   * Terms of Service" in place of the player). Measured 2026-11-22 (Chrome, direct watch-page
   * loads): the HTML's embedded `var ytInitialPlayerResponse = {...}` (also the source of
   * ytplayer.bootstrapPlayerResponse) arrives with playabilityStatus OK. YouTube's main app
   * (kevlar_base yje / kHz / Kgb, i4Q.handleResponse, read 2026-11-22) checks it against
   * responseContext.mainAppWebResponseContext.trackingParam (an obfuscated list of path / value
   * pairs) and, for a marked session, about 1.4 s after navigation start replaces
   * playabilityStatus with an ERROR copy: errorScreen.enforcementMessageViewModel (built by Kgb
   * from auxiliaryUi.messageRenderers.bkaEnforcementMessageViewModel with a displayType ending in
   * _PLAYER) or errorScreen.playerErrorMessageRenderer with subreason 282054944 (kHz), and sets
   * videoDetails to undefined. That happens on an untouched response too (not caused by our
   * pruning).
   * 1. Guard (from document start): every response object stored in window.ytInitialPlayerResponse
   *    or window.ytplayer.bootstrapPlayerResponse (ytplayer may be created later; trapPath) that
   *    is OK gets accessors on playabilityStatus and videoDetails (guardResponse) that ignore
   *    exactly that swap: a playabilityStatus that is not OK and carries
   *    errorScreen.enforcementMessageViewModel or a playerErrorMessageRenderer whose subreason
   *    contains 282054944, and the videoDetails = undefined that follows it. Any other write goes
   *    through. The trap chains with an accessor already on the property (the youtube rule runs
   *    prune-on-assign on ytInitialPlayerResponse first): its setter stores the value and the
   *    guard is applied to what its getter returns, the object the page and the player read.
   *    Measured: 3 test videos played 2.5 s, 6.1 s and 6.2 s after navigation start with no block
   *    screen (before: block screen shown, playing at about 8.7 s).
   *    The main app runs the same check on the player responses of in-page navigation (fetch
   *    /youtubei/v1/get_watch, an array whose items carry playerResponse; /youtubei/v1/player;
   *    seen live 2026-11-22: "Something went wrong ... 282054944"), so the same guard is applied
   *    to every object a JSON.parse (only when the text contains "playabilityStatus") or a
   *    Response.prototype.json returns: the object, its array items, their .playerResponse and
   *    endpoint.watchEndpoint.unserializedPrefetchData.playerResponse (resolve_url prefetch); a
   *    few key lookups, no deep walk. Installed after json-prune / json-prune-fetch-response
   *    (rule order), so it wraps them and guards the pruned object. Covers fetch bodies read with
   *    json() or text() + JSON.parse and XHR responseText + JSON.parse; not XHR responseType json.
   * 2. Reload (the fallback, when the response the player uses is still enforced, isEnforced:
   *    playabilityStatus.status ERROR or UNPLAYABLE together with the error screen of the swap
   *    above (isEnforcementSwap: errorScreen.enforcementMessageViewModel, or
   *    playerErrorMessageRenderer with subreason 282054944, the common case since we prune
   *    bkaEnforcementMessageViewModel) or auxiliaryUi.messageRenderers.bkaEnforcementMessageViewModel): ask the player for the video
   *    again with #movie_player.loadVideoById(v, t) (uBO reloads on UNPLAYABLE the same way); a
   *    fresh /youtubei/v1/player request in the same session was answered OK, and loadVideoById
   *    by hand on the error screen played the video, measured 2026-11-22.
   * The response is read with the player's getPlayerResponse(), which is whatever the player
   * uses: the page-embedded response on a direct load, the get_watch / player response after
   * in-page navigation or after our reload. Polled every TICK (100) ms from document start on a
   * /watch?v= page (and again from yt-navigate-finish / yt-player-updated / DOMContentLoaded,
   * which may not fire on the error screen), for at most MAX_TICKS ticks (20 s) after the start or
   * the last reload. An OK response seen before the video plays does not end the watch: the swap
   * above comes after it, so polling goes on until the player is playing (state 1). The player
   * is only asked once it is ready: the page has loaded (document.readyState 'complete'; a call
   * while the page is still loading was swallowed, measured 2026-11-22) or the player itself has
   * reported onStateChange 5 (cued) or -1 (unstarted) to us (subscribed with
   * player.addEventListener once the element carries the player API), getPlayerState() is 5, -1
   * or 3 now (with the enforced response: a player left on the 282054944 screen sat in 3 after
   * the load event, measured 2026-11-23), and the enforced response has been seen on
   * SETTLE_TICKS consecutive ticks (0.3 s).
   * Start time: the URL's t= (90, 90s, 1m30s, 1h2m3s) or 0. A reload that leaves the same
   * response object in place for RETRY_TICKS ticks (3 s) while the player is still cued /
   * unstarted counts as a failed try; a reload answered with the enforcement again is retried
   * too; at most MAX_TRIES reloads per video for the life of the page, then we give up and leave
   * the screen.
   * Only after a reload whose new response for this video is OK: the stale
   * yt-playability-error-supported-renderers are hidden (display:none !important),
   * ytd-watch-flexy loses its player-unavailable attribute (YouTube leaves both in place after a
   * successful loadVideoById, measured 2026-11-22) and the player (#movie_player, its ytd-player)
   * loses a hidden attribute / inline display:none; repeated RECHECKS ms later in case YouTube
   * re-renders them. The hiding and the attribute are given back on yt-navigate-start, so YouTube
   * shows the next page's own errors. Other playability errors (private, age gate, region,
   * LOGIN_REQUIRED) are never touched.
   */
  var RECOVER_MAX_TRIES = 3;
  var RECOVER_TICK = 100;
  // 20 s
  var RECOVER_MAX_TICKS = 200;
  // 0.3 s of a loaded (or cued) page and ready player with the enforced response
  var RECOVER_SETTLE_TICKS = 3;
  // 3 s without a new response after a reload
  var RECOVER_RETRY_TICKS = 30;
  // first check after yt-navigate-start
  var RECOVER_NAV_DELAY = 1000;
  var RECOVER_RECHECKS = [1000, 3000];
  var ERROR_RENDERERS = 'yt-playability-error-supported-renderers';

  function playabilityOf(resp) {
    var ps = isObj(resp) ? resp.playabilityStatus : null;
    return isObj(ps) ? ps : null;
  }

  function isEnforced(resp) {
    var ps = playabilityOf(resp);
    if (!ps || (ps.status !== 'ERROR' && ps.status !== 'UNPLAYABLE')) return false;
    if (isEnforcementSwap(ps)) return true;
    var aux = isObj(resp.auxiliaryUi) ? resp.auxiliaryUi.messageRenderers : null;
    return isObj(aux) && isObj(aux.bkaEnforcementMessageViewModel);
  }

  function urlParam(search, name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(search || ''));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
  }

  /** YouTube's t= value in seconds: 90, 90s, 1m30s, 1h2m3s; anything else 0. */
  function startSeconds(t) {
    if (/^\d+$/.test(t)) return Number(t);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    if (!m || !(m[1] || m[2] || m[3])) return 0;
    return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  }

  /** The main app's swap of an OK playabilityStatus for the enforcement one (see above). */
  function isEnforcementSwap(x) {
    if (!isObj(x) || x.status === 'OK' || !isObj(x.errorScreen)) return false;
    if (isObj(x.errorScreen.enforcementMessageViewModel)) return true;
    var pe = x.errorScreen.playerErrorMessageRenderer;
    return isObj(pe) && JSON.stringify(pe.subreason || '').indexOf('282054944') >= 0;
  }

  function youtubePlayabilityRecover(win, args, log) {
    var NAME = 'youtube-playability-recover';

    /** An OK response keeps playabilityStatus and videoDetails through the enforcement swap. */
    function guardResponse(v) {
      try {
        if (!isObj(v) || !isObj(v.playabilityStatus) || v.playabilityStatus.status !== 'OK') return;
        var dps = getOwnDesc(v, 'playabilityStatus'), dvd = getOwnDesc(v, 'videoDetails');
        if (!dps || !dps.configurable || dps.get || (dvd && (!dvd.configurable || dvd.get))) return;
        var ps = v.playabilityStatus, vd = v.videoDetails, blocked = false;
        defineProperty(v, 'playabilityStatus', { enumerable: true, configurable: true, get: function () { return ps; }, set: function (x) {
          if (isEnforcementSwap(x)) { blocked = true; log(NAME, 'kept the playable response'); return; }
          ps = x;
        } });
        defineProperty(v, 'videoDetails', { enumerable: dvd ? dvd.enumerable : true, configurable: true, get: function () { return vd; }, set: function (x) {
          if (x === undefined && blocked) { blocked = false; return; }
          vd = x;
        } });
      } catch (e) { /* leave it */ }
    }

    /**
     * trapPath leaf: guard every value stored at owner[key]. An accessor already there (from
     * prune-on-assign) is chained: its setter stores the value, and the guard is applied to what
     * its getter returns. Otherwise the value is kept here. A non-configurable property is left.
     */
    function guardLeaf(owner, key) {
      var d = getOwnDesc(owner, key) || {};
      if (d.configurable === false) return;
      var acc = d.get || d.set, value = d.value;
      function stored() {
        try { return acc ? d.get && reflectApply(d.get, owner, []) : value; } catch (e) { return undefined; }
      }
      guardResponse(stored());
      defineLeaf(owner, key, stored, function (v) {
        if (!acc) value = v; else if (d.set) reflectApply(d.set, owner, [v]);
        guardResponse(stored());
      });
    }

    // 1. The embedded response.
    trapPath(win, ['ytInitialPlayerResponse'], guardLeaf);
    trapPath(win, ['ytplayer', 'bootstrapPlayerResponse'], guardLeaf);

    // ... and fetched ones (after json-prune*, which wrap first): o, o[i], .playerResponse and the
    // resolve_url prefetch playerResponse. JSON.parse only walks a text with the needle.
    function guardAll(o) {
      try {
        [].concat(o).forEach(function (x) {
          if (!isObj(x)) return;
          var e = x.endpoint, u = isObj(e) && isObj(e.watchEndpoint) && e.watchEndpoint.unserializedPrefetchData;
          [x, x.playerResponse, isObj(u) && u.playerResponse].forEach(guardResponse);
        });
      } catch (e) { /* leave it */ }
    }
    wrap(win, win.JSON, 'parse', function (t, self, a) {
      var r = reflectApply(t, self, a);
      if (typeof a[0] === 'string' && a[0].indexOf('"playabilityStatus"') !== -1) guardAll(r);
      return r;
    });
    wrap(win, typeof win.Response === 'function' ? win.Response.prototype : null, 'json', function (t, self, a) {
      var p = reflectApply(t, self, a);
      try { return p.then(function (o) { guardAll(o); return o; }); } catch (e) { return p; }
    });

    // 2. The reload fallback.
    var doc = win.document;
    if (!doc || typeof doc.addEventListener !== 'function' || typeof win.setTimeout !== 'function') return;
    // tries: videoId -> loadVideoById calls so far; job: the watch page being looked after;
    // undo: functions that give back what clean-up changed; heard: players we listen to.
    var tries = {};
    var job = null;
    var undo = [];
    var heard = new WeakSet();

    /** Subscribe once per player element to its onStateChange: 5 / -1 marks the job cued. */
    function listen(player) {
      try {
        if (!player || heard.has(player)) return;
        if (typeof player.addEventListener !== 'function' || typeof player.getPlayerState !== 'function') return;
        heard.add(player);
        player.addEventListener('onStateChange', function (st) {
          if ((st === 5 || st === -1) && job) job.cued = true;
        });
      } catch (e) { /* poll readyState only */ }
    }

    function currentVideo() {
      var loc = win.location;
      if (!loc || loc.pathname !== '/watch') return '';
      var v = urlParam(loc.search, 'v');
      return /^[\w-]{11}$/.test(v) ? v : '';
    }

    function responseOf(player) {
      try {
        return player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      } catch (e) {
        return null;
      }
    }

    /** getPlayerState(), or null without a player state (no player, no method, it throws). */
    function stateOf(player) {
      try {
        return player && typeof player.getPlayerState === 'function' ? player.getPlayerState() : null;
      } catch (e) {
        return null;
      }
    }

    /**
     * Cued (5) or unstarted (-1): the player shows the error screen and takes a loadVideoById.
     * buffering: also 3, for an enforced response (it cannot be buffering content; measured
     * 2026-11-23, the player sat in 3 on the error screen after the load event).
     */
    function ready(player, buffering) {
      var s = stateOf(player);
      return (s === 5 || s === -1 || (buffering && s === 3)) && typeof player.loadVideoById === 'function';
    }

    function show(el) {
      try {
        if (!el) return;
        if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) el.removeAttribute('hidden');
        if (el.style && el.style.display === 'none') el.style.display = '';
      } catch (e) { /* leave it */ }
    }

    function cleanup(player) {
      try {
        var list = doc.querySelectorAll(ERROR_RENDERERS);
        for (var i = 0; list && i < list.length; i++) {
          var s = list[i].style;
          if (!s || typeof s.setProperty !== 'function') continue;
          if (s.getPropertyValue('display') === 'none' && s.getPropertyPriority('display') === 'important') continue;
          (function (st, val, prio) {
            undo.push(function () {
              if (val) st.setProperty('display', val, prio); else st.removeProperty('display');
            });
          })(s, s.getPropertyValue('display'), s.getPropertyPriority('display'));
          s.setProperty('display', 'none', 'important');
        }
        var flexy = doc.querySelector('ytd-watch-flexy');
        if (flexy && typeof flexy.hasAttribute === 'function' && flexy.hasAttribute('player-unavailable')) {
          var was = typeof flexy.getAttribute === 'function' ? flexy.getAttribute('player-unavailable') : '';
          flexy.removeAttribute('player-unavailable');
          undo.push(function () { flexy.setAttribute('player-unavailable', was || ''); });
        }
        show(player);
        show(player && typeof player.closest === 'function' ? player.closest('ytd-player') : null);
      } catch (e) { /* leave the page alone */ }
    }

    function recovered(j, player) {
      cleanup(player);
      log(NAME, 'recovered');
      RECOVER_RECHECKS.forEach(function (ms) {
        win.setTimeout(function () {
          try {
            if (job === null && currentVideo() === j.vid && undo.length) cleanup(doc.querySelector('#movie_player'));
          } catch (e) { /* leave it */ }
        }, ms);
      });
    }

    function giveBack() {
      var list = undo;
      undo = [];
      list.forEach(function (fn) { try { fn(); } catch (e) { /* gone */ } });
    }

    function schedule(j) {
      if (j.timer || job !== j) return;
      if (j.ticks - j.since >= RECOVER_MAX_TICKS || j.ticks >= RECOVER_MAX_TICKS * 3) { job = null; return; }
      j.timer = true;
      win.setTimeout(function () {
        j.timer = false;
        if (job === j) step(j);
      }, RECOVER_TICK);
    }

    function reload(j, player, resp) {
      tries[j.vid] = (tries[j.vid] || 0) + 1;
      j.blocked = resp;
      j.recovering = true;
      j.seen = 0;
      j.since = j.ticks;
      log(NAME, 'reload');
      player.loadVideoById(j.vid, j.start);
    }

    function step(j) {
      try {
        if (currentVideo() !== j.vid) { job = null; return; }
        j.ticks++;
        var player = doc.querySelector('#movie_player');
        listen(player);
        var resp = responseOf(player);
        var details = isObj(resp) && isObj(resp.videoDetails) ? resp.videoDetails : null;
        var forThis = isObj(resp) && (!details || !details.videoId || details.videoId === j.vid);
        if (forThis && resp === j.blocked) {
          // Our reload has not replaced the response. Still cued / unstarted after RETRY_TICKS:
          // the call was swallowed, a failed try. Loading (3) or playing (1): wait for it.
          if (j.ticks - j.since < RECOVER_RETRY_TICKS || !ready(player)) { schedule(j); return; }
          j.blocked = null;
          log(NAME, 'reload had no effect');
        }
        if (forThis && playabilityOf(resp)) {
          if (isEnforced(resp)) {
            if ((tries[j.vid] || 0) >= RECOVER_MAX_TRIES) { job = null; log(NAME, 'gave up'); return; }
            // A reload while the page is still loading was swallowed by the player (measured in
            // Chrome 2026-11-22): wait for the load event, or for the player to report itself
            // cued / unstarted, then a settled, ready player (3 counts: see ready()).
            var loaded = doc.readyState === 'complete' || j.cued;
            if (!loaded || !ready(player, true)) { j.seen = 0; j.since = j.ticks; schedule(j); return; }
            if (++j.seen >= RECOVER_SETTLE_TICKS) reload(j, player, resp);
            schedule(j);
            return;
          }
          var ps = playabilityOf(resp);
          if (j.recovering && ps.status === 'OK') { job = null; recovered(j, player); return; }
          // OK without our reload: YouTube can still swap in an enforced response a moment later
          // (measured 2026-11-22: the page's response is OK, the player's turns ERROR), so keep
          // watching until the video plays. A playability error of another kind: not ours.
          if (ps.status !== 'OK' || stateOf(player) === 1) { job = null; return; }
          j.seen = 0;
          schedule(j);
          return;
        }
        schedule(j);
      } catch (e) {
        if (job === j) job = null;
      }
    }

    function check() {
      try {
        var vid = currentVideo();
        if (!vid) { job = null; return; }
        if (!job || job.vid !== vid) {
          job = {
            vid: vid, start: startSeconds(urlParam(win.location.search, 't')),
            ticks: 0, since: 0, seen: 0, blocked: null, recovering: false, timer: false, cued: false
          };
        }
        schedule(job);
      } catch (e) { /* leave the page alone */ }
    }

    ['DOMContentLoaded', 'yt-navigate-finish', 'yt-player-updated'].forEach(function (type) {
      doc.addEventListener(type, check, true);
    });
    // yt-navigate-start also fires during a direct load, and yt-navigate-finish may not follow on
    // the error screen: start checking again on our own shortly after.
    doc.addEventListener('yt-navigate-start', function () {
      job = null;
      giveBack();
      win.setTimeout(check, RECOVER_NAV_DELAY);
    }, true);
    // A direct load: from document start, the events may never come.
    check();
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
        lookNative(getter, desc.get);
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
      'edit-request-body': editRequestBody,
      'prevent-setTimeout': preventSetTimeout,
      'adjust-setTimeout': adjustSetTimeout,
      'prevent-promise-then-callback': preventPromiseThen,
      'remove-attr': removeAttr,
      'remove-class': removeClass,
      'prevent-dom-bypass': preventDomBypass,
      'remove-node-text': removeNodeText,
      'youtube-drop-player-event': youtubeDropPlayerEvent,
      'youtube-ad-skip': youtubeAdSkip,
      'youtube-enforcement-dismiss': youtubeEnforcementDismiss,
      'youtube-playability-recover': youtubePlayabilityRecover
    },
    protectFrames: protectFrames,
    makePruner: makePruner,
    makeMatcher: makeMatcher,
    parseValue: parseValue
  };
})();
