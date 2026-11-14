/*
 * General page script (ISOLATED world, top frame, document_start, all http(s) sites except the
 * allowlist). Registered by src/background/general.js only while ad or cookie-banner hiding is
 * on. Deliberately tiny: no MutationObserver, no DOM scanning loop, no timers that repeat.
 *
 *  1. Says hello to the background ({type: 'as-page'}); the background injects this site's
 *     cosmetic CSS (EasyList / EasyList Cookie List site rules) with chrome.scripting.insertCSS.
 *     Generic hiding needs no script at all: it is a registered CSS file.
 *  2. Once, after the page has loaded and the browser is idle, checks whether one of this
 *     site's cookie-banner selectors matched, and if so reports one "banner hidden" for the
 *     popup count.
 */
(function (root) {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (root.__as_general_installed__) return;
  root.__as_general_installed__ = true;
  var doc = root.document;
  var host = root.location && root.location.hostname;
  if (!host || !doc) return;

  function send(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      return p && typeof p.then === 'function' ? p.catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) {
      return Promise.resolve(null); // extension reloaded or disabled
    }
  }

  function checkOnce(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        if (doc.querySelector(selectors[i])) { send({ type: 'as-banner' }); return true; }
      } catch (e) { /* selector not supported by this browser */ }
    }
    return false;
  }

  function later(selectors) {
    var run = function () {
      if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(function () { checkOnce(selectors); }, { timeout: 3000 });
      else checkOnce(selectors);
    };
    var wait = function () { setTimeout(run, 1500); };
    if (doc.readyState === 'complete') wait();
    else root.addEventListener('load', wait, { once: true });
  }

  var t = 0;
  try { t = Math.floor(root.performance.timeOrigin); } catch (e) { t = 0; }
  send({ type: 'as-page', host: host, t: t }).then(function (resp) {
    var sels = resp && Array.isArray(resp.cookieSelectors) ? resp.cookieSelectors : [];
    if (sels.length) later(sels);
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
