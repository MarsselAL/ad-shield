/*
 * Tiny logger. Prefix "[TAS]". debug/info only print when debug logging is on; warn/error
 * always print. tasLoggerFactory has no outer-scope references so it can be inlined into the
 * worker blob with Function.prototype.toString.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] logger.js needs config.js first');

  function tasLoggerFactory() {
    /**
     * @param {string} scope   e.g. "page", "worker"
     * @param {function():boolean} isDebug  read on every call so toggling takes effect live
     * @param {object} [sink]  console-like object (tests pass a fake)
     */
    return function createLogger(scope, isDebug, sink) {
      var out = sink || (typeof console !== 'undefined' ? console : null);
      var prefix = '[TAS]' + (scope ? '[' + scope + ']' : '');
      function emit(level, args) {
        if (!out) return;
        var fn = out[level] || out.log;
        if (typeof fn !== 'function') return;
        try { fn.apply(out, [prefix].concat(Array.prototype.slice.call(args))); } catch (e) { /* ignore */ }
      }
      function dbg() { try { return !!(isDebug && isDebug()); } catch (e) { return false; } }
      return {
        debug: function () { if (dbg()) emit('debug', arguments); },
        info: function () { if (dbg()) emit('info', arguments); },
        warn: function () { emit('warn', arguments); },
        error: function () { emit('error', arguments); }
      };
    };
  }

  ns.loggerFactory = tasLoggerFactory;
  ns.createLogger = tasLoggerFactory();
})(typeof globalThis !== 'undefined' ? globalThis : this);
