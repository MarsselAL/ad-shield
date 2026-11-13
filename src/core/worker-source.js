/*
 * Builds the source of the replacement video worker:
 *
 *   ["use strict";]                     only if Twitch's worker starts with that directive
 *   /* __TAS_WORKER__ * /                marker, so a worker is never wrapped twice
 *   ;(function () {
 *     var cfg  = <config JSON>;  var boot = <settings + degraded channels JSON>;
 *     var M    = (<m3u8 factory source>)();
 *     ...                                processor + logger factories
 *     (<worker main source>)(self, cfg, boot, M, createProcessor, createLogger);
 *   })();
 *   <Twitch's original worker source, unchanged>
 *
 * Everything is our own bundled code serialised with Function.prototype.toString plus data
 * as JSON; no remote code and no eval. Pure string building, tested in jsc.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__;
  if (!ns) throw new Error('[TAS] worker-source.js needs config.js first');

  var MARKER = '__TAS_WORKER__';

  function startsWithUseStrict(src) {
    return /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(['"])use strict\1/.test(src);
  }

  var LS = new RegExp(String.fromCharCode(0x2028), 'g');
  var PS = new RegExp(String.fromCharCode(0x2029), 'g');

  function json(v) {
    // Escape characters that would end a script or break a JS string literal context.
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');
  }

  /**
   * @param parts { m3u8Factory, processorFactory, loggerFactory, workerMain } functions
   * @param cfg   config object
   * @param boot  { settings, degraded }
   * @param originalSource Twitch's worker script text
   */
  function buildWorkerSource(parts, cfg, boot, originalSource) {
    ['m3u8Factory', 'processorFactory', 'loggerFactory', 'workerMain'].forEach(function (k) {
      if (typeof parts[k] !== 'function') throw new Error('[TAS] buildWorkerSource: missing ' + k);
    });
    var original = String(originalSource || '');
    var prelude = [
      '/* ' + MARKER + ' */',
      ';(function () {',
      '  var cfg = ' + json(cfg) + ';',
      '  var boot = ' + json(boot || {}) + ';',
      '  try {',
      '    var M = (' + parts.m3u8Factory.toString() + ')();',
      '    var createProcessor = (' + parts.processorFactory.toString() + ')();',
      '    var createLogger = (' + parts.loggerFactory.toString() + ')();',
      '    (' + parts.workerMain.toString() + ')(self, cfg, boot, M, createProcessor, createLogger);',
      '  } catch (e) {',
      '    try { console.warn("[TAS][worker] hook install failed, worker runs unmodified", e); } catch (e2) {}',
      '  }',
      '})();'
    ].join('\n');
    return (startsWithUseStrict(original) ? '"use strict";\n' : '') + prelude + '\n' + original;
  }

  function isWrapped(source) {
    return String(source || '').indexOf(MARKER) !== -1;
  }

  ns.buildWorkerSource = buildWorkerSource;
  ns.isWrappedWorkerSource = isWrapped;
})(typeof globalThis !== 'undefined' ? globalThis : this);
