/*
 * Pop-under click guard (ISOLATED world, every frame, document_start, all http(s) sites except
 * the allowlist). Registered by src/background/general.js only while Ads is on, right after
 * rules/cosmetic/popunder.css.
 *
 * Pop-under libraries cover the page or the video player with an invisible full-viewport layer
 * (fixed, maximum z-index, opacity 0 or a transparent background) and open an ad tab from its
 * click handler, so the first click on "play" goes to an ad. popunder.css hides the known inline
 * forms of that layer; this catches the rest by computed style, at the moment it is clicked:
 * when a trusted pointer, mouse, click or touch event targets an invisible, childless, fixed
 * layer at z-index >= 2147483000 that covers at least 90% of the viewport, the layer is hidden
 * (display and pointer-events none, !important) and the event never reaches the page's handlers
 * (our capture listeners on the window are registered before any page script, so they run
 * first; preventDefault also stops an <a target=_blank> overlay from navigating). The next
 * click then lands on the player underneath.
 *
 * Deliberately tiny: no MutationObserver, no timers, no DOM scanning; work only happens on
 * trusted pointer / mouse / click / touch events. No chrome.* calls, counts nothing, logs
 * nothing. Any exception is swallowed: the guard must never break a page.
 */
(function (root) {
  'use strict';
  if (!root || root.__as_clickguard__) return;

  var MIN_Z = 2147483000;
  var SKIP = {
    IFRAME: 1, FRAME: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IMG: 1, PICTURE: 1, SVG: 1, svg: 1, OBJECT: 1,
    EMBED: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, HTML: 1, BODY: 1
  };
  // Layers already hidden: a touch or pen pointer stays captured by its pointerdown target, so
  // the pointerup / touchend / click of the same gesture still arrive on the hidden layer.
  var caught = typeof WeakSet === 'function' ? new WeakSet() : null;

  /** "transparent", "rgba(0, 0, 0, 0)", "rgb(0 0 0 / 0)", "rgba(0, 0, 0, 0%)": alpha 0. */
  function transparentColor(c) {
    c = String(c || '').trim().toLowerCase();
    if (c === 'transparent') return true;
    var m = /^rgba?\(([^)]*)\)$/.exec(c);
    if (!m) return false;
    var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    return parts.length === 4 && parseFloat(parts[3]) === 0;
  }

  /** The invisible full-viewport layer of a pop-under script. */
  function isCatcher(el) {
    if (!el || el.nodeType !== 1 || SKIP[el.tagName] === 1) return false;
    if (el.childElementCount !== 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    var cs = view.getComputedStyle(el);
    if (!cs || cs.position !== 'fixed') return false;
    if (!(parseInt(cs.zIndex, 10) >= MIN_Z)) return false;
    var w = view.innerWidth, h = view.innerHeight;
    if (!(w > 0 && h > 0)) return false;
    var r = el.getBoundingClientRect();
    var cw = Math.min(r.right, w) - Math.max(r.left, 0);
    var ch = Math.min(r.bottom, h) - Math.max(r.top, 0);
    if (!(cw >= 0.9 * w && ch >= 0.9 * h)) return false;
    if (parseFloat(cs.opacity) === 0) return true;
    return transparentColor(cs.backgroundColor) && cs.backgroundImage === 'none' && String(el.textContent || '').trim() === '';
  }

  function guard(e, mayPrevent) {
    try {
      if (!e || !e.isTrusted) return;
      var t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (!(caught && caught.has(t)) && !isCatcher(t)) return;
      if (caught) caught.add(t);
      t.style.setProperty('display', 'none', 'important');
      t.style.setProperty('pointer-events', 'none', 'important');
      e.stopImmediatePropagation();
      if (mayPrevent) e.preventDefault();
    } catch (err) { /* never break the page */ }
  }

  var api = { isCatcher: isCatcher, guard: guard };
  root.__as_clickguard__ = api;
  if (typeof root.addEventListener !== 'function') return;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'touchend'].forEach(function (type) {
    root.addEventListener(type, function (e) { guard(e, true); }, { capture: true });
  });
  // touchstart on the window is passive by default in Chrome (preventDefault would only log a
  // warning); stay passive so scrolling never waits for us. touchend still cancels the click.
  root.addEventListener('touchstart', function (e) { guard(e, false); }, { capture: true, passive: true });
})(typeof globalThis !== 'undefined' ? globalThis : this);
