/*
 * src/content/clickguard.js: the generic pop-under click guard. Fake window / element / computed
 * style objects only (no DOM in jsc). The script is loaded twice into this global, which stands in
 * for the content script's window.
 */
var listeners = [];
globalThis.addEventListener = function (type, fn, opts) { listeners.push({ type: type, fn: fn, opts: opts }); };
load('src/content/clickguard.js');
load('src/content/clickguard.js');
var CG = globalThis.__as_clickguard__;

var W = 1280, H = 720;
var win = {
  innerWidth: W, innerHeight: H,
  getComputedStyle: function (el) { return el._cs; }
};

/* An element as clickguard.js sees it. o: tag, cs (computed style overrides), rect, kids, text. */
function el(o) {
  o = o || {};
  var cs = Object.assign({ position: 'fixed', zIndex: '2147483647', opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' }, o.cs || {});
  var r = o.rect || { left: 0, top: 0, right: W, bottom: H };
  var e = {
    nodeType: 1, tagName: o.tag || 'DIV', childElementCount: o.kids || 0, textContent: o.text === undefined ? '' : o.text,
    ownerDocument: { defaultView: win }, _cs: cs, set: [],
    getBoundingClientRect: function () { return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top }; }
  };
  e.style = { setProperty: function (p, v, prio) { e.set.push([p, v, prio]); } };
  return e;
}
function ev(type, target, trusted) {
  var e = { type: type, target: target, isTrusted: trusted !== false, cancelable: true, stopped: 0, prevented: 0 };
  e.stopImmediatePropagation = function () { e.stopped++; };
  e.preventDefault = function () { e.prevented++; };
  return e;
}
function handler(type) {
  var l = listeners.filter(function (x) { return x.type === type; });
  assert.equal(l.length, 1, 'one listener for ' + type);
  return l[0].fn;
}
function fire(type, target, trusted) { var e = ev(type, target, trusted); handler(type)(e); return e; }

var UIX = { cs: { opacity: '0' }, text: '\n' };                          // video embed page: opacity 0, whitespace inside
var HAGOROMO = { cs: { backgroundColor: 'rgba(0, 0, 0, 0)' } };         // empty transparent div

test('installs once: capture listeners on the window for the pointer, mouse, click and touch events', function () {
  assert.ok(CG && typeof CG.isCatcher === 'function', 'exported for tests');
  assert.deepEqual(listeners.map(function (l) { return l.type; }).sort(),
    ['auxclick', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchend', 'touchstart']);
  listeners.forEach(function (l) { assert.equal(l.opts && l.opts.capture, true, l.type + ' in the capture phase'); });
  assert.equal(listeners.filter(function (l) { return l.type === 'touchstart'; })[0].opts.passive, true, 'touchstart stays passive (no scroll cost)');
});

test('uix_99-like layer (opacity 0, whitespace text): caught, hidden with !important, event stopped', function () {
  var t = el(UIX);
  assert.ok(CG.isCatcher(t));
  var e = fire('pointerdown', t);
  assert.deepEqual(t.set, [['display', 'none', 'important'], ['pointer-events', 'none', 'important']]);
  assert.equal(e.stopped, 1, 'stopImmediatePropagation');
  assert.equal(e.prevented, 1, 'preventDefault');
});

test('once caught, later events of the same gesture on it are stopped too (pointer capture keeps the hidden target)', function () {
  var t = el(UIX);
  fire('pointerdown', t);
  // Hidden now: zero-size box, so it no longer looks like a catcher by itself.
  t.getBoundingClientRect = function () { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  assert.notOk(CG.isCatcher(t));
  ['pointerup', 'mouseup', 'click', 'touchend'].forEach(function (type) {
    var e = fire(type, t);
    assert.equal(e.stopped, 1, type + ' stopped');
    assert.equal(e.prevented, 1, type + ' default prevented');
  });
});

test('Hagoromo-like empty transparent div: caught on click', function () {
  var t = el(HAGOROMO);
  var e = fire('click', t);
  assert.equal(e.stopped, 1);
  assert.equal(e.prevented, 1);
  assert.equal(t.set.length, 2);
  assert.ok(CG.isCatcher(el({ cs: { backgroundColor: 'transparent' } })), 'keyword transparent');
  assert.ok(CG.isCatcher(el({ cs: { backgroundColor: 'rgb(0 0 0 / 0)' } })), 'space syntax with alpha 0');
});

test('transparent <A> overlay without text: caught and its click default prevented (no navigation)', function () {
  var a = el({ tag: 'A' });
  var e = fire('click', a);
  assert.equal(e.prevented, 1);
  assert.equal(e.stopped, 1);
  var aux = fire('auxclick', el({ tag: 'A' }));
  assert.equal(aux.prevented, 1, 'middle click too');
});

test('touchstart: hidden and stopped, but no preventDefault in the passive listener', function () {
  var t = el(UIX);
  var e = fire('touchstart', t);
  assert.equal(t.set.length, 2);
  assert.equal(e.stopped, 1);
  assert.equal(e.prevented, 0);
  var end = fire('touchend', t);
  assert.equal(end.prevented, 1, 'touchend cancels the synthesized click');
});

test('opacity 0 is invisible even with a background image; transparent with a background image is not', function () {
  assert.ok(CG.isCatcher(el({ cs: { opacity: '0', backgroundImage: 'url("x.png")', backgroundColor: 'rgb(255, 0, 0)' } })));
  assert.notOk(CG.isCatcher(el({ cs: { backgroundImage: 'url("x.png")' } })));
});

test('not caught: page content and ordinary overlays', function () {
  var cases = {
    'modal backdrop': el({ cs: { backgroundColor: 'rgba(0, 0, 0, 0.5)' } }),
    'opaque background': el({ cs: { backgroundColor: 'rgb(255, 255, 255)' } }),
    'has a child element': el({ cs: { opacity: '0' }, kids: 1 }),
    'z-index 1000': el({ cs: { zIndex: '1000' } }),
    'z-index auto': el({ cs: { zIndex: 'auto' } }),
    'covers half the viewport width': el({ rect: { left: 0, top: 0, right: W / 2, bottom: H } }),
    'covers half the viewport height': el({ rect: { left: 0, top: 0, right: W, bottom: H / 2 } }),
    'mostly off screen': el({ rect: { left: W * 0.6, top: 0, right: W * 1.6, bottom: H } }),
    'position absolute': el({ cs: { position: 'absolute' } }),
    'position sticky': el({ cs: { position: 'sticky' } }),
    'transparent div with visible text': el({ text: 'Click to continue' }),
    'opacity 0.5': el({ cs: { opacity: '0.5', backgroundColor: 'rgb(0, 0, 0)' } }),
    IFRAME: el({ tag: 'IFRAME' }),
    VIDEO: el({ tag: 'VIDEO', cs: { opacity: '0' } }),
    CANVAS: el({ tag: 'CANVAS' }),
    svg: el({ tag: 'svg' }),
    BUTTON: el({ tag: 'BUTTON' }),
    BODY: el({ tag: 'BODY' }),
    HTML: el({ tag: 'HTML' })
  };
  Object.keys(cases).forEach(function (name) {
    var t = cases[name];
    assert.notOk(CG.isCatcher(t), name);
    var e = fire('click', t);
    assert.equal(e.stopped + e.prevented, 0, name + ': event untouched');
    assert.equal(t.set.length, 0, name + ': not hidden');
  });
});

test('not caught: untrusted (script-dispatched) events, non-elements, broken targets', function () {
  var t = el(UIX);
  var e = fire('click', t, false);
  assert.equal(e.stopped + e.prevented, 0);
  assert.equal(t.set.length, 0);
  [null, undefined, {}, { nodeType: 3 }, { nodeType: 9 }].forEach(function (x) {
    var e2 = fire('click', x);
    assert.equal(e2.stopped + e2.prevented, 0);
  });
  var broken = el(UIX);
  broken.getBoundingClientRect = function () { throw new Error('detached'); };
  var e3 = fire('pointerdown', broken);
  assert.equal(e3.stopped + e3.prevented, 0, 'an exception never breaks the page');
  assert.notOk(CG.isCatcher(el({ cs: { opacity: '0' } , rect: { left: 0, top: 0, right: 0, bottom: 0 } })), 'zero-size');
});

test('a zero-size viewport (hidden frame) never matches', function () {
  var saved = [win.innerWidth, win.innerHeight];
  win.innerWidth = 0; win.innerHeight = 0;
  try {
    assert.notOk(CG.isCatcher(el({ cs: { opacity: '0' }, rect: { left: 0, top: 0, right: 0, bottom: 0 } })));
  } finally { win.innerWidth = saved[0]; win.innerHeight = saved[1]; }
});
