/*
 * Global Privacy Control (https://privacycg.github.io/gpc-spec/): navigator.globalPrivacyControl.
 * MAIN world, every frame, document_start; registered by blocking.contentScriptPlan (id as-gpc)
 * while the "Global Privacy Control" switch is on, never on allowlisted sites. The matching
 * Sec-GPC: 1 request header comes from the static ruleset rules/gpc.json.
 * Defined only where the browser has no such property (Chrome has none; Brave and Firefox do,
 * and another extension may have set one): an accessor on Navigator.prototype, enumerable like a
 * WebIDL attribute (DuckDuckGo's content-scope-scripts do the same). Our own code (MIT).
 */
(function () {
  'use strict';
  try {
    if (typeof Navigator !== 'function' || typeof navigator !== 'object' || 'globalPrivacyControl' in navigator) return;
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
      get: function () { return true; },
      configurable: true,
      enumerable: true
    });
  } catch (e) { /* frozen prototype or a conflicting definition: leave the page alone */ }
})();
