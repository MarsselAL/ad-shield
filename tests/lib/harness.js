/*
 * Minimal test harness for JavaScriptCore's jsc shell (print, load, readFile, drainMicrotasks).
 * Usage: jsc tests/lib/harness.js tests/<name>.test.js tests/lib/finish.js   (run from the repo root)
 */
var __tests = [];
var __results = { passed: 0, failed: 0, failures: [] };

function test(name, fn) { __tests.push({ name: name, fn: fn }); }

function loadSrc() {
  for (var i = 0; i < arguments.length; i++) load(arguments[i]);
}

function fixture(name) { return readFile('tests/fixtures/' + name); }

function __fmt(v) {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); } catch (e) { return String(v); }
}

var assert = {
  ok: function (v, msg) { if (!v) throw new Error((msg || 'expected truthy') + ' (got ' + __fmt(v) + ')'); },
  notOk: function (v, msg) { if (v) throw new Error((msg || 'expected falsy') + ' (got ' + __fmt(v) + ')'); },
  equal: function (a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + __fmt(a) + ' !== ' + __fmt(b)); },
  deepEqual: function (a, b, msg) {
    var x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error((msg || 'not deep-equal') + ': ' + x + ' !== ' + y);
  },
  includes: function (hay, needle, msg) {
    if (String(hay).indexOf(needle) === -1) throw new Error((msg || 'missing substring') + ': ' + __fmt(needle));
  },
  notIncludes: function (hay, needle, msg) {
    if (String(hay).indexOf(needle) !== -1) throw new Error((msg || 'unexpected substring') + ': ' + __fmt(needle));
  },
  throws: function (fn, msg) {
    var threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'expected an exception');
  }
};

function __runAll() {
  var chain = Promise.resolve();
  __tests.forEach(function (t) {
    chain = chain.then(function () {
      return Promise.resolve().then(t.fn).then(function () {
        __results.passed++;
        print('  ok   ' + t.name);
      }, function (e) {
        __results.failed++;
        __results.failures.push(t.name);
        print('  FAIL ' + t.name + '\n       ' + (e && e.message ? e.message : e));
      });
    });
  });
  return chain;
}

/*
 * Deterministic fake timers (jsc has setTimeout but no clearTimeout, and would wait for real
 * timers at exit). Timers only fire when a test calls __advanceTimers(ms).
 */
var __timers = { now: 0, nextId: 1, list: {} };
globalThis.setTimeout = function (fn, ms) {
  var id = __timers.nextId++;
  __timers.list[id] = { fn: fn, at: __timers.now + (ms || 0) };
  return id;
};
globalThis.clearTimeout = function (id) { delete __timers.list[id]; };
globalThis.setInterval = function (fn, ms) {
  var id = __timers.nextId++;
  __timers.list[id] = { fn: fn, at: __timers.now + ms, every: ms };
  return id;
};
globalThis.clearInterval = globalThis.clearTimeout;
function __advanceTimers(ms) {
  var end = __timers.now + ms;
  for (;;) {
    var dueId = null, due = null;
    Object.keys(__timers.list).forEach(function (id) {
      var t = __timers.list[id];
      if (t.at <= end && (!due || t.at < due.at)) { due = t; dueId = id; }
    });
    if (!due) break;
    __timers.now = due.at;
    if (due.every) due.at += due.every; else delete __timers.list[dueId];
    due.fn();
  }
  __timers.now = end;
}
