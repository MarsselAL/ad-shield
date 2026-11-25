/* src/content/gpc.js: navigator.globalPrivacyControl in the page (MAIN world), on fake Navigator objects. */

function fresh(native) {
  globalThis.Navigator = function Navigator() {};
  if (native !== undefined) {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: function () { return native; }, configurable: true, enumerable: true });
  }
  globalThis.navigator = new Navigator();
}

function cleanup() {
  delete globalThis.Navigator;
  delete globalThis.navigator;
}

test('gpc.js: defines a true getter on Navigator.prototype where the browser has none', function () {
  fresh();
  try {
    load('src/content/gpc.js');
    assert.equal(navigator.globalPrivacyControl, true);
    assert.ok('globalPrivacyControl' in navigator);
    assert.notOk(Object.prototype.hasOwnProperty.call(navigator, 'globalPrivacyControl'), 'not an own property of the instance');
    var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'globalPrivacyControl');
    assert.equal(typeof d.get, 'function');
    assert.equal(d.set, undefined, 'read-only');
    assert.equal(d.enumerable, true, 'like a WebIDL attribute');
    assert.equal(d.configurable, true);
    navigator.globalPrivacyControl = false;
    assert.equal(navigator.globalPrivacyControl, true, 'assignment in sloppy mode is ignored');
  } finally { cleanup(); }
});

test('gpc.js: keeps an existing value (Brave / Firefox native, or another extension)', function () {
  fresh(false);
  try {
    var before = Object.getOwnPropertyDescriptor(Navigator.prototype, 'globalPrivacyControl');
    load('src/content/gpc.js');
    assert.equal(navigator.globalPrivacyControl, false, 'the user agent value wins');
    assert.equal(Object.getOwnPropertyDescriptor(Navigator.prototype, 'globalPrivacyControl').get, before.get);
  } finally { cleanup(); }
});

test('gpc.js: no Navigator (or a frozen prototype) does not throw', function () {
  cleanup();
  load('src/content/gpc.js');
  globalThis.Navigator = function Navigator() {};
  globalThis.navigator = new Navigator();
  Object.freeze(Navigator.prototype);
  try {
    load('src/content/gpc.js');
    assert.equal(navigator.globalPrivacyControl, undefined);
  } finally { cleanup(); }
});
