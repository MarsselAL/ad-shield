/*
 * Surrogate for Google Tag Manager and the Google tag: www.googletagmanager.com/gtm.js,
 * www.googletagmanager.com/gtag/js and www.google-analytics.com/gtm/js. Served by AdBrake's
 * privacy_surrogates DNR redirect rules instead of the blocked script. Our own code (MIT); the
 * behaviour follows DuckDuckGo's tracker-surrogates gtm.js (Apache-2.0), no code copied.
 *
 * Pages that wait for a tag before they continue (a link that navigates in the eventCallback /
 * event_callback, a form that submits there, the Optimize "anti-flicker" snippet) would hang
 * with the script just blocked. This stub keeps window.dataLayer an ordinary array and, for
 * every entry already queued and every later push:
 *  - GTM: { event, eventCallback, eventTimeout } -> eventCallback() soon after;
 *  - gtag: gtag('event', name, { event_callback }) -> event_callback() soon after;
 *          gtag('get', target, field, callback) -> callback(undefined);
 *  - dataLayer.hide.end() (anti-flicker) is called once.
 * Nothing is sent anywhere.
 */
(function () {
  'use strict';
  var w = window;
  var dl = Array.isArray(w.dataLayer) ? w.dataLayer : (w.dataLayer = []);
  if (dl.__adbrakeSurrogate) return; // gtm.js and gtag/js on the same page: hook once
  try { Object.defineProperty(dl, '__adbrakeSurrogate', { value: true }); } catch (e) { /* frozen */ }

  function later(fn, arg) {
    setTimeout(function () {
      try { fn(arg); } catch (e) { /* the page's callback failed: not ours to report */ }
    }, 0);
  }

  function handle(item) {
    if (!item || typeof item !== 'object') return;
    if (typeof item.eventCallback === 'function') {
      later(item.eventCallback);
    } else if (typeof item.length === 'number' && item.length > 0) {
      // gtag() pushes its arguments object: [command, target or name, params, callback]
      if (item[0] === 'event' && item[2] && typeof item[2] === 'object' && typeof item[2].event_callback === 'function') {
        later(item[2].event_callback);
      } else if (item[0] === 'get' && typeof item[3] === 'function') {
        later(item[3], undefined);
      }
    }
  }

  for (var i = 0; i < dl.length; i++) handle(dl[i]);
  var push = dl.push;
  dl.push = function () {
    for (var j = 0; j < arguments.length; j++) handle(arguments[j]);
    return push.apply(this, arguments);
  };
  if (dl.hide && typeof dl.hide.end === 'function') {
    try { dl.hide.end(); } catch (e) { /* ignore */ }
    dl.hide.end = null;
  }
})();
