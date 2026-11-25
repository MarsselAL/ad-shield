/*
 * Element picker ("Hide an element on this page" in the popup). Injected on demand only, with
 * src/shared/selector.js before it: chrome.scripting.executeScript, ISOLATED world, top frame.
 * Nothing of it runs on pages where the user did not click the button.
 *
 * UI: one <as-picker> element on <html>, fixed, full-viewport, max z-index, pointer-events none,
 * styled inline with !important (page CSS cannot hide or restyle it), with a CLOSED shadow root
 * holding the highlight box and the panel. All styles are set through CSSOM (element.style),
 * which a page's Content-Security-Policy does not block, unlike <style> elements.
 *  - Moving the mouse outlines the element under it; a click picks it (the click never reaches
 *    the page). Clicks on our panel are let through to the panel.
 *  - The panel shows the generated selector (editable), "Wider" / "Narrower" (parent / back
 *    towards the picked element), and a live preview: every match is hidden with an inline
 *    style while the picker is open, and the count is shown.
 *  - "Hide" (or Enter) sends {type: 'as-picker-save', selector} to the background, which stores
 *    it in "My filters" for this site and inserts the CSS into the tab. "Cancel" / Esc quits and
 *    restores everything the preview hid.
 * Running it again while it is open restarts it.
 */
(function (root) {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  var doc = root.document;
  var Sel = root.__TAS__ && root.__TAS__.selector;
  if (!doc || !doc.documentElement || !Sel) return;
  if (root.__as_picker__) root.__as_picker__.quit();

  var Z = '2147483647';
  var host = doc.createElement('as-picker');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;display:block!important;' +
    'z-index:' + Z + '!important;pointer-events:none!important;visibility:visible!important;opacity:1!important;';
  var shadow = host.attachShadow({ mode: 'closed' });

  function el(tag, css, text) {
    var e = doc.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  var FONT = 'font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;';
  var box = el('div', 'position:fixed;display:none;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #e5242b;background:rgba(229,36,43,.14);border-radius:4px;');
  var panel = el('div', 'position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);' +
    'box-sizing:border-box;padding:14px;border-radius:16px;background:rgba(255,255,255,.82);color:#1c1c1e;' +
    'pointer-events:auto;-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);' +
    'box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 36px rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.6);' + FONT);
  var title = el('div', 'font-weight:600;margin:0 0 4px;', 'AdBrake: hide an element');
  var hint = el('div', 'color:#636366;margin:0 0 8px;', 'Point at the element and click it. Esc cancels.');
  var input = el('input', 'display:block;width:100%;box-sizing:border-box;margin:0 0 6px;padding:5px 6px;' +
    'border:1px solid rgba(60,60,67,.24);border-radius:10px;background:rgba(255,255,255,.9);color:#1c1c1e;' +
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'CSS selector';
  input.setAttribute('aria-label', 'CSS selector of the elements to hide');
  var info = el('div', 'color:#636366;margin:0 0 8px;min-height:1.4em;', '');
  var row = el('div', 'display:flex;flex-wrap:wrap;gap:6px;');
  function button(label, primary) {
    var b = el('button', 'all:initial;cursor:pointer;padding:6px 12px;border-radius:10px;font-weight:500;' + FONT +
      (primary ? 'background:#e5242b;color:#fff;border:1px solid #e5242b;font-weight:600;'
        : 'background:rgba(255,255,255,.9);color:#1c1c1e;border:1px solid rgba(60,60,67,.18);'), label);
    b.type = 'button';
    row.appendChild(b);
    return b;
  }
  var wider = button('Wider');
  var narrower = button('Narrower');
  var move = button('Move panel');
  var hide = button('Hide', true);
  var cancel = button('Cancel');
  panel.appendChild(title);
  panel.appendChild(hint);
  panel.appendChild(input);
  panel.appendChild(info);
  panel.appendChild(row);
  shadow.appendChild(box);
  shadow.appendChild(panel);

  var chain = [];      // picked element, then its ancestors up to (not including) <body>
  var level = 0;
  var selector = '';
  var hidden = [];     // preview: [{ el, value, priority }]
  var hoverEl = null;
  var frame = 0;
  var busy = false;

  function setDisabled(b, off) {
    b.disabled = off;
    b.style.opacity = off ? '0.45' : '1';
    b.style.cursor = off ? 'default' : 'pointer';
  }

  function drawBox(target) {
    if (!target || target === host || !target.getBoundingClientRect) { box.style.display = 'none'; return; }
    var r = target.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function restorePreview() {
    hidden.forEach(function (h) {
      try { h.el.style.setProperty('display', h.value, h.priority); if (!h.value) h.el.style.removeProperty('display'); } catch (e) { /* gone */ }
    });
    hidden = [];
  }

  /** Validate the selector, hide its matches (preview), update the count and the buttons. */
  function preview(sel) {
    restorePreview();
    selector = (sel || '').trim();
    var list = null, err = '';
    if (selector) {
      try { list = doc.querySelectorAll(selector); } catch (e) { err = 'Not a valid CSS selector.'; }
    }
    if (list) {
      var arr = Array.prototype.slice.call(list);
      if (arr.indexOf(doc.body) !== -1 || arr.indexOf(doc.documentElement) !== -1 || host.matches(selector)) {
        err = 'This would hide the whole page.';
        list = null;
      }
    }
    if (list) {
      Array.prototype.forEach.call(list, function (m) {
        hidden.push({ el: m, value: m.style.getPropertyValue('display'), priority: m.style.getPropertyPriority('display') });
        m.style.setProperty('display', 'none', 'important');
      });
    }
    var n = list ? list.length : 0;
    info.style.color = err ? '#b91c1c' : '#636366';
    info.textContent = err || (!selector ? 'Nothing picked yet.' : n === 0 ? 'Matches nothing on this page.'
      : 'Hides ' + n + (n === 1 ? ' element' : ' elements') + ' (preview).');
    setDisabled(hide, busy || !!err || n === 0);
    setDisabled(wider, busy || !chain.length || level >= chain.length - 1);
    setDisabled(narrower, busy || level <= 0);
  }

  function generate() {
    var target = chain[level];
    restorePreview(); // the selector must be built on the unmodified page
    input.value = (target && Sel.forElement(target, doc)) || '';
    preview(input.value);
  }

  function pick(target) {
    if (!target || target.nodeType !== 1 || target === host || target === doc.body || target === doc.documentElement) return;
    restorePreview();
    chain = [];
    for (var n = target; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) chain.push(n);
    level = 0;
    hint.textContent = 'Use Wider / Narrower or edit the selector, then Hide. Esc cancels.';
    generate();
  }

  function save() {
    if (busy || hide.disabled) return;
    busy = true;
    preview(selector);
    info.style.color = '#636366';
    info.textContent = 'Saving…';
    var sent;
    try {
      sent = chrome.runtime.sendMessage({ type: 'as-picker-save', selector: selector });
    } catch (e) {
      sent = Promise.reject(e);
    }
    Promise.resolve(sent).then(function (r) {
      if (r && r.ok) {
        info.textContent = 'Saved. Hidden on this site from now on (Settings > My filters).';
        setTimeout(quit, 1200);
        return;
      }
      throw new Error(r && r.error ? r.error : 'Could not save.');
    }).catch(function (e) {
      busy = false;
      preview(selector);
      info.style.color = '#b91c1c';
      info.textContent = (e && e.message) || 'Could not save (reload the page and try again).';
    });
  }

  // ---------------------------------------------------------------- events
  function ours(e) { return e.target === host; }

  function onMove(e) {
    if (ours(e)) { hoverEl = null; box.style.display = 'none'; return; }
    hoverEl = e.target;
    if (!frame) {
      frame = root.requestAnimationFrame(function () { frame = 0; drawBox(hoverEl); });
    }
  }

  function swallow(e) {
    if (ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && !busy) pick(e.target);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') quit();
      return;
    }
    if (e.key === 'Enter' && e.type === 'keydown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      save();
      return;
    }
    // Typing in our selector field must not trigger the page's keyboard shortcuts.
    if (ours(e)) e.stopImmediatePropagation();
  }

  function onScroll() { if (hoverEl) drawBox(hoverEl); }

  var MOUSE = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'contextmenu'];
  var KEYS = ['keydown', 'keyup', 'keypress'];

  function listen(on) {
    var f = on ? 'addEventListener' : 'removeEventListener';
    root[f]('mousemove', onMove, true);
    MOUSE.forEach(function (t) { root[f](t, swallow, true); });
    KEYS.forEach(function (t) { root[f](t, onKey, true); });
    root[f]('scroll', onScroll, true);
    root[f]('resize', onScroll, true);
  }

  function quit() {
    listen(false);
    restorePreview();
    if (host.parentNode) host.parentNode.removeChild(host);
    if (root.__as_picker__ === api) delete root.__as_picker__;
  }

  wider.addEventListener('click', function () { if (level < chain.length - 1) { level++; generate(); } });
  narrower.addEventListener('click', function () { if (level > 0) { level--; generate(); } });
  hide.addEventListener('click', save);
  cancel.addEventListener('click', quit);
  move.addEventListener('click', function () {
    var right = panel.style.right !== 'auto';
    panel.style.right = right ? 'auto' : '16px';
    panel.style.left = right ? '16px' : 'auto';
  });
  input.addEventListener('input', function () { if (!busy) preview(input.value); });

  var api = { quit: quit };
  root.__as_picker__ = api;
  doc.documentElement.appendChild(host);
  listen(true);
  preview('');
})(typeof globalThis !== 'undefined' ? globalThis : this);
