/*
 * CSS selector helpers for the element picker (src/content/picker.js).
 * Injected together with picker.js (chrome.scripting.executeScript, ISOLATED world, top frame,
 * only when the user clicks "Hide an element on this page"); also loaded by the jsc tests.
 *
 *  - looksRandom(token): true for ids / class names that look generated (long digit runs, hex
 *    or base-62 hashes, CSS-modules / styled-components / emotion suffixes). Such names change
 *    between page loads or site builds, so a selector using them would stop working.
 *  - stableId(id), stableClasses(list): the usable ones.
 *  - step(info): one selector step from { tag, id, classes, index, sameTag } (pure).
 *  - forElement(el, doc): the selector for a picked element: "#id" if unique, else
 *    "tag.class" if unique, else a "parent > child:nth-of-type(n)" path up to an ancestor with a
 *    unique id/class step (or body). The result is checked with doc.querySelectorAll and always
 *    matches `el`; null if no selector could be built.
 * No chrome.* use.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};

  var IDENT_RE = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
  var MAX_CLASSES = 2;
  var MAX_DEPTH = 8;

  /** True when an id / class name looks machine-generated (changes between builds or loads). */
  function looksRandom(token) {
    var t = String(token || '');
    if (!t || t.length > 40) return true;
    if (/\d{4,}/.test(t)) return true;                                   // post-12345, ad_93821
    if (/^(css|jsx|svelte|astro|emotion)-[A-Za-z0-9]{4,}$/.test(t)) return true; // css-1q2w3e
    if (/^sc-[A-Za-z0-9]{4,}$/.test(t)) return true;                     // styled-components
    if (/__[A-Za-z0-9_-]{5,}$/.test(t) && /[0-9]/.test(t.slice(t.lastIndexOf('__')))) return true; // Btn_root__a1B2c
    var parts = t.split(/[-_]+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length < 5) continue;
      var digits = (p.match(/[0-9]/g) || []).length;
      var hasAlpha = /[A-Za-z]/.test(p);
      var wordy = /[a-z]{4,}/.test(p);                // a real word inside: mp4Player, h264video
      var uppers = (p.slice(1).match(/[A-Z]/g) || []).length;
      if (digits >= 2 && hasAlpha && /^[0-9a-f]+$/i.test(p)) return true;  // a1b2c3, 3fa9e0
      if (digits >= 1 && uppers >= 1 && /[a-z]/.test(p) && !wordy) return true; // xY7kQ, aB3dE
      // styled-components hash classes without the sc- prefix: kOaVfE, bdVaJa
      if (!digits && /^[A-Za-z]{5,7}$/.test(p) && uppers >= 2 && !/[a-z]{3,}/.test(p)) return true;
    }
    return false;
  }

  function stableId(id) {
    return typeof id === 'string' && IDENT_RE.test(id) && !looksRandom(id) ? id : null;
  }

  function stableClasses(list) {
    var out = [];
    (list || []).forEach(function (c) {
      if (typeof c === 'string' && IDENT_RE.test(c) && !looksRandom(c) && out.indexOf(c) === -1) out.push(c);
    });
    return out;
  }

  /**
   * One selector step. info: { tag, id, classes, index (1-based among siblings of the same tag),
   * sameTag (number of such siblings), useId, useClasses (count), nth (force :nth-of-type) }.
   */
  function step(info) {
    var tag = String(info.tag || '*').toLowerCase();
    if (info.useId && stableId(info.id)) return '#' + info.id;
    var s = tag;
    var cls = stableClasses(info.classes).slice(0, info.useClasses || 0);
    cls.forEach(function (c) { s += '.' + c; });
    if (info.nth && info.sameTag > 1) s += ':nth-of-type(' + info.index + ')';
    return s;
  }

  function classesOf(el) {
    var c = el.getAttribute && el.getAttribute('class');
    return c ? String(c).split(/\s+/).filter(Boolean) : [];
  }

  function siblingInfo(el) {
    var parent = el.parentElement, index = 1, same = 1;
    if (parent) {
      same = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var c = parent.children[i];
        if (c.tagName === el.tagName) {
          same++;
          if (c === el) index = same;
        }
      }
    }
    return { index: index, sameTag: same };
  }

  function count(doc, sel) {
    try { return doc.querySelectorAll(sel).length; } catch (e) { return -1; }
  }

  function matches(doc, sel, el) {
    try {
      var all = doc.querySelectorAll(sel);
      for (var i = 0; i < all.length; i++) if (all[i] === el) return true;
    } catch (e) { /* invalid */ }
    return false;
  }

  /** Shortest step that matches only `el` in the document, or null. */
  function uniqueStep(el, doc) {
    var tag = el.tagName.toLowerCase();
    var id = stableId(el.id);
    if (id && count(doc, '#' + id) === 1) return '#' + id;
    var cls = stableClasses(classesOf(el));
    for (var i = 0; i < cls.length; i++) {
      var s1 = tag + '.' + cls[i];
      if (count(doc, s1) === 1) return s1;
    }
    for (var a = 0; a < cls.length && a < 4; a++) {
      for (var b = a + 1; b < cls.length && b < 5; b++) {
        var s2 = tag + '.' + cls[a] + '.' + cls[b];
        if (count(doc, s2) === 1) return s2;
      }
    }
    return null;
  }

  /** Step used inside a path (unique among its siblings when possible). */
  function pathStep(el) {
    var sib = siblingInfo(el);
    var cls = stableClasses(classesOf(el));
    var info = { tag: el.tagName, classes: cls, index: sib.index, sameTag: sib.sameTag, useClasses: Math.min(cls.length, MAX_CLASSES) };
    var parent = el.parentElement;
    if (parent && sib.sameTag > 1) {
      // Classes alone may already single it out among its siblings.
      var withCls = step(info), n = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var c = parent.children[i];
        if (c.tagName === el.tagName && cls.slice(0, MAX_CLASSES).every(function (k) { return classesOf(c).indexOf(k) !== -1; })) n++;
      }
      if (n > 1 || !info.useClasses) { info.nth = true; info.useClasses = 0; }
      else return withCls;
    }
    return step(info);
  }

  /** Selector for a picked element (see the header), or null. */
  function forElement(el, doc) {
    if (!el || el.nodeType !== 1 || !doc) return null;
    var tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'head') return null;
    var own = uniqueStep(el, doc);
    if (own) return own;
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < MAX_DEPTH) {
      var t = cur.tagName.toLowerCase();
      if (t === 'body' || t === 'html') { parts.unshift(t === 'html' ? 'html' : 'body'); break; }
      var u = depth > 0 ? uniqueStep(cur, doc) : null;
      if (u) { parts.unshift(u); break; }
      parts.unshift(pathStep(cur));
      cur = cur.parentElement;
      depth++;
    }
    // Shorten from the left while the path still matches only this element.
    for (var k = parts.length - 1; k >= 1; k--) {
      var shorter = parts.slice(k).join(' > ');
      if (count(doc, shorter) === 1 && matches(doc, shorter, el)) return shorter;
    }
    var full = parts.join(' > ');
    return matches(doc, full, el) ? full : null;
  }

  ns.selector = {
    looksRandom: looksRandom,
    stableId: stableId,
    stableClasses: stableClasses,
    step: step,
    forElement: forElement
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
