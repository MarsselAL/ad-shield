/*
 * Surrogate for https://www.google-analytics.com/analytics.js (Universal Analytics, window.ga).
 * Served by AdBrake's privacy_surrogates DNR redirect rule instead of the blocked script. Our own
 * code (MIT), written from the public analytics.js command API; nothing is sent anywhere.
 *
 * Keeps pages that wait for Analytics working: ga(function (tracker) {...}) ready callbacks run,
 * hitCallback (in a fields object, or set with ga('set', 'hitCallback', fn)) runs soon after
 * every 'send', and the commands queued in ga.q before the script "loaded" are replayed. Trackers
 * answer get() with undefined; create / getByName / getAll / remove work on a local list.
 */
(function () {
  'use strict';
  var w = window;
  var name = typeof w.GoogleAnalyticsObject === 'string' && w.GoogleAnalyticsObject ? w.GoogleAnalyticsObject : 'ga';
  var old = w[name];
  if (typeof old === 'function' && old.loaded === true && typeof old.getAll === 'function') return; // already loaded

  function later(fn, arg) {
    setTimeout(function () {
      try { fn(arg); } catch (e) { /* the page's callback failed: not ours to report */ }
    }, 0);
  }

  var trackers = [];
  function Tracker(trackerName) {
    this.fields = { name: trackerName };
  }
  Tracker.prototype.get = function (field) { return field === 'name' ? this.fields.name : undefined; };
  Tracker.prototype.set = function (field, value) {
    if (field && typeof field === 'object') {
      for (var k in field) if (Object.prototype.hasOwnProperty.call(field, k)) this.fields[k] = field[k];
    } else if (typeof field === 'string') {
      this.fields[field] = value;
    }
  };
  Tracker.prototype.send = function () {
    var cb = this.fields.hitCallback;
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (a && typeof a === 'object' && typeof a.hitCallback === 'function') cb = a.hitCallback;
    }
    if (typeof cb === 'function') later(cb);
  };
  Tracker.prototype.require = function () {};
  Tracker.prototype.provide = function () {};

  function byName(n) {
    for (var i = 0; i < trackers.length; i++) if (trackers[i].fields.name === n) return trackers[i];
    return null;
  }

  function create() {
    var n = 't0';
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (a && typeof a === 'object' && typeof a.name === 'string') n = a.name;
      else if (i === 2 && typeof a === 'string') n = a; // ga('create', id, cookieDomain, name)
    }
    var t = byName(n);
    if (!t) { t = new Tracker(n); trackers.push(t); }
    return t;
  }

  function ga(command) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof command === 'function') {
      later(command, trackers[0] || create());
      return;
    }
    if (typeof command !== 'string') return;
    var dot = command.indexOf('.');
    var trackerName = dot > 0 ? command.slice(0, dot) : 't0';
    var method = dot > 0 ? command.slice(dot + 1) : command;
    if (method === 'create') { create.apply(null, args); return; }
    if (method === 'remove') { ga.remove(trackerName); return; }
    var t = byName(trackerName);
    if (method === 'send') {
      if (t) { t.send.apply(t, args); return; }
      // No tracker created (or the name is unknown): still release a waiting page.
      args.forEach(function (a) { if (a && typeof a === 'object' && typeof a.hitCallback === 'function') later(a.hitCallback); });
      return;
    }
    if (method === 'set' && t) t.set(args[0], args[1]);
  }
  ga.create = function () { return create.apply(null, arguments); };
  ga.getByName = byName;
  ga.getAll = function () { return trackers.slice(); };
  ga.remove = function (n) {
    for (var i = 0; i < trackers.length; i++) {
      if (trackers[i].fields.name === n) { trackers.splice(i, 1); return; }
    }
  };
  ga.loaded = true;
  ga.l = old && old.l ? old.l : Date.now();
  ga.q = [];

  w[name] = ga;
  var queue = old && Array.isArray(old.q) ? old.q.slice() : [];
  for (var i = 0; i < queue.length; i++) {
    try { ga.apply(null, Array.prototype.slice.call(queue[i])); } catch (e) { /* ignore one bad command */ }
  }
})();
