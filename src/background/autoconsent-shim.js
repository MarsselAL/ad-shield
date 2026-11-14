/*
 * Gives the vendored CommonJS build of DuckDuckGo autoconsent (vendor/autoconsent/
 * autoconsent.cjs.js, MPL-2.0, unmodified) a `module` object to export into, so the classic
 * service worker can load it with importScripts. src/background/general.js then uses its
 * evalSnippets and filterCompactRules exports.
 */
/* exported module, exports */
var module = { exports: {} };
var exports = module.exports;
