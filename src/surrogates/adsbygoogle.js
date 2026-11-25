/*
 * Surrogate for https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js (AdSense and the
 * Ad Placement API used by web games). Served by AdBrake's ads_surrogates DNR redirect rule
 * instead of the blocked script. Our own code (MIT), written from the public API; no ad loads.
 *
 * window.adsbygoogle becomes { loaded: true, push } (what the real script leaves behind). Each
 * pushed object, and each one queued before the script "loaded":
 *  - Ad Placement API adBreak(): adBreakDone({ breakStatus: 'notReady', ... }) runs soon after,
 *    so a game waiting for its interstitial / rewarded break goes on (no beforeAd, no reward);
 *  - adConfig(): onReady() runs soon after;
 *  - anything else (an <ins class="adsbygoogle"> slot) is ignored.
 */
(function () {
  'use strict';
  var w = window;
  var old = w.adsbygoogle;
  if (old && !Array.isArray(old) && old.loaded === true) return; // already loaded

  function later(fn, arg) {
    setTimeout(function () {
      try { fn(arg); } catch (e) { /* the page's callback failed: not ours to report */ }
    }, 0);
  }

  function handle(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.adBreakDone === 'function') {
      later(o.adBreakDone, {
        breakType: typeof o.type === 'string' ? o.type : '',
        breakName: typeof o.name === 'string' ? o.name : '',
        breakFormat: o.type === 'reward' ? 'reward' : o.type === 'preroll' ? 'preroll' : 'interstitial',
        breakStatus: 'notReady'
      });
    }
    if (typeof o.onReady === 'function') later(o.onReady);
  }

  var stub = {
    loaded: true,
    push: function () {
      for (var i = 0; i < arguments.length; i++) handle(arguments[i]);
      return 0;
    }
  };
  var queue = Array.isArray(old) ? old.slice() : [];
  w.adsbygoogle = stub;
  for (var i = 0; i < queue.length; i++) handle(queue[i]);
})();
