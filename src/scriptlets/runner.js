/*
 * Picks the scriptlets of rules/scriptlets.json for the page's host and runs them (MAIN world,
 * document_start, every frame). Bundled by tools/build.py into build/scriptlets-main.js after
 * src/scriptlets/lib.js, inside one function scope, so nothing is left on the page's window.
 *
 * Host matching: a rule's host covers itself and its subdomains ("youtube.com" covers
 * "www.youtube.com" and "m.youtube.com", not "notyoutube.com"). about:blank / srcdoc frames have
 * no hostname of their own; they inherit the creator's origin, read from document.domain or
 * self.origin.
 */
/* exported asScriptletRunner */
var asScriptletRunner = (function () {
  'use strict';

  function hostOf(win) {
    var h = '';
    try { h = win.location.hostname; } catch (e) { h = ''; }
    if (!h) { try { h = win.document.domain; } catch (e) { h = ''; } }
    if (!h) {
      try {
        var m = /^https?:\/\/([^/:]+)/.exec(String(win.origin));
        h = m ? m[1] : '';
      } catch (e) { h = ''; }
    }
    return String(h || '').toLowerCase().replace(/\.$/, '');
  }

  function covers(entry, host) {
    return host === entry || (host.length > entry.length && host.slice(-(entry.length + 1)) === '.' + entry);
  }

  /** [[name, ...args], ...] of every rule whose hosts cover host, in file order. */
  function pick(table, host) {
    var out = [];
    if (!host || !table || !Array.isArray(table.rules)) return out;
    table.rules.forEach(function (rule) {
      var hosts = Array.isArray(rule.hosts) ? rule.hosts : [];
      var hit = hosts.some(function (h) { return typeof h === 'string' && covers(h, host); });
      if (!hit || !Array.isArray(rule.scriptlets)) return;
      rule.scriptlets.forEach(function (s) {
        if (Array.isArray(s) && typeof s[0] === 'string') out.push(s);
      });
    });
    return out;
  }

  function apply(win, lib, list, log, framesOnly) {
    var ran = [];
    list.forEach(function (s) {
      var fn = lib.scriptlets[s[0]];
      if (typeof fn !== 'function' || (framesOnly && !fn.frames)) return;
      try {
        fn(win, s.slice(1).map(String), log);
        ran.push(s[0]);
      } catch (e) {
        log(s[0], 'setup failed: ' + (e && e.message));
      }
    });
    return ran;
  }

  /** Run the scriptlets for win's host; returns the names that ran (for tests). */
  function run(win, lib, table, log) {
    var say = typeof log === 'function' ? log : function () {};
    var list = pick(table, hostOf(win));
    if (!list.length) return [];
    var ran = apply(win, lib, list, say, false);
    var net = list.filter(function (s) { var f = lib.scriptlets[s[0]]; return f && f.frames; });
    if (net.length) {
      var onFrame = function (child) {
        apply(child, lib, net, say, true);
        lib.protectFrames(child, onFrame);
      };
      lib.protectFrames(win, onFrame);
    }
    return ran;
  }

  return { hostOf: hostOf, covers: covers, pick: pick, run: run };
})();
