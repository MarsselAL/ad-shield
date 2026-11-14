/*
 * Background part of the general (all-sites) blocker. Loaded by service-worker.js with
 * importScripts after config.js, settings.js, logger.js, blocking.js and the vendored
 * autoconsent library (vendor/autoconsent/autoconsent.cjs.js via autoconsent-shim.js).
 *
 *  - enables/disables the generated static rulesets (ads_N, ads_curated, privacy_N,
 *    privacy_curated, cookies_N, cookie_strip) via blocking.rulesetPlan;
 *  - keeps one dynamic allowAllRequests rule for the per-site allowlist;
 *  - registers the cosmetic CSS / small page script / autoconsent content scripts with
 *    chrome.scripting.registerContentScripts (only when the plan changed);
 *  - injects per-site cosmetic CSS (chrome.scripting.insertCSS, USER origin) when the page
 *    script says hello, and counts "banner hidden" / autoconsent opt-outs per page;
 *  - answers the autoconsent content script's messages (init / eval / autoconsentDone ...),
 *    following the protocol documented in autoconsent's docs/api.md.
 * Everything it reads is packaged with the extension: no network requests, no remote config.
 */
/* global chrome */
(function () {
  'use strict';
  var ns = self.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
  var lib = self.module && self.module.exports;
  var AC = lib && lib.evalSnippets && typeof lib.filterCompactRules === 'function' ? lib : null;
  var state = { settings: S.defaults(), blocking: B.defaults() };
  var log = ns.createLogger('general', function () { return !!state.settings.debug; });
  var SIG_KEY = 'contentScriptPlan';
  var PAGE_PREFIX = 'page:';

  var queue = Promise.resolve();
  function enqueue(fn) {
    var p = queue.then(fn, fn);
    queue = p.catch(function (e) { log.error('task failed', e && e.message ? e.message : e); });
    return p;
  }

  var cache = {};
  function loadJson(path) {
    if (!cache[path]) {
      cache[path] = fetch(chrome.runtime.getURL(path)).then(function (r) { return r.json(); });
      cache[path].catch(function () { delete cache[path]; });
    }
    return cache[path];
  }

  function readState() {
    return chrome.storage.local.get([S.STORAGE_KEY, B.STORAGE_KEY]).then(function (r) {
      state = { settings: S.normalize(r[S.STORAGE_KEY]), blocking: B.normalize(r[B.STORAGE_KEY]) };
      return state;
    });
  }

  function staticRulesetIds() {
    var dnr = chrome.runtime.getManifest().declarative_net_request || {};
    return (dnr.rule_resources || []).map(function (r) { return r.id; });
  }

  function syncRulesets(st) {
    var plan = B.rulesetPlan(staticRulesetIds(), st.settings.enabled, st.blocking);
    return chrome.declarativeNetRequest.updateEnabledRulesets(plan).catch(function (e) {
      // Over the static rule limit: say so, keep going with the rest.
      log.error('updateEnabledRulesets failed', e && e.message);
    });
  }

  function syncAllowlist(st) {
    return chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [B.ALLOWLIST_RULE_ID],
      addRules: B.allowlistRules(st.settings.enabled, st.blocking.allowlist)
    });
  }

  function registerOne(script) {
    return chrome.scripting.registerContentScripts([script]).catch(function (e) {
      log.warn('registerContentScripts failed for', script.id, e && e.message);
      if (!script.css || !script.excludeMatches) return undefined;
      // Fall back to excluding only the allowlist (an exception host pattern was rejected).
      var allow = [];
      state.blocking.allowlist.forEach(function (h) { allow.push.apply(allow, B.hostPatterns(h)); });
      var copy = Object.assign({}, script);
      if (allow.length) copy.excludeMatches = allow; else delete copy.excludeMatches;
      return chrome.scripting.registerContentScripts([copy]).catch(function (e2) {
        log.error('registerContentScripts failed again for', script.id, e2 && e2.message);
      });
    });
  }

  function syncScripts(st) {
    var needSite = st.settings.enabled && (st.blocking.ads || st.blocking.hideCookieBanners);
    var siteP = needSite ? loadJson('rules/cosmetic/site.json').catch(function () { return null; }) : Promise.resolve(null);
    return Promise.all([siteP, chrome.storage.local.get(SIG_KEY), chrome.scripting.getRegisteredContentScripts()]).then(function (res) {
      var plan = B.contentScriptPlan(st.settings.enabled, st.blocking, B.cosmeticExcludeHosts(res[0]));
      var sig = JSON.stringify(plan);
      var ours = (res[2] || []).filter(function (s) { return s.id.indexOf(B.SCRIPT_PREFIX) === 0; });
      if (res[1][SIG_KEY] === sig && ours.length === plan.length) return undefined;
      var ids = ours.map(function (s) { return s.id; });
      var p = ids.length ? chrome.scripting.unregisterContentScripts({ ids: ids }) : Promise.resolve();
      return p.then(function () {
        return Promise.all(plan.map(registerOne));
      }).then(function () {
        var o = {};
        o[SIG_KEY] = sig;
        log.debug('content scripts registered:', plan.map(function (s) { return s.id; }).join(', ') || 'none');
        return chrome.storage.local.set(o);
      });
    });
  }

  function apply() {
    return enqueue(function () {
      return readState().then(function (st) {
        try {
          chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true }).catch(function () {});
        } catch (e) { /* older Chrome */ }
        return Promise.all([syncRulesets(st), syncAllowlist(st), syncScripts(st)]);
      });
    });
  }

  // ---------------------------------------------------------------- per-page state
  function pageKey(tabId) { return PAGE_PREFIX + tabId; }

  function updatePage(tabId, fn) {
    return enqueue(function () {
      var key = pageKey(tabId);
      return chrome.storage.session.get(key).then(function (r) {
        var o = {};
        o[key] = fn(r[key] || { t: 0, hidden: 0, rejected: 0 });
        return chrome.storage.session.set(o);
      });
    });
  }

  function topHost(sender) {
    var u = (sender.tab && sender.tab.url) || sender.url || '';
    var m = /^https?:\/\/([^/:?#]+)/i.exec(u);
    return m ? m[1] : '';
  }

  function allowedHere(sender) {
    return B.isAllowlisted(topHost(sender), state.blocking.allowlist);
  }

  function onPage(msg, sender, sendResponse) {
    var tabId = sender.tab.id;
    var frameId = sender.frameId || 0;
    if (frameId === 0) {
      var t = typeof msg.t === 'number' && msg.t > 0 ? msg.t : Date.now();
      updatePage(tabId, function () { return { t: t, hidden: 0, rejected: 0 }; });
    }
    readState().then(function (st) {
      var b = st.blocking;
      if (!st.settings.enabled || allowedHere(sender) || !(b.ads || b.hideCookieBanners)) return { cookieSelectors: [] };
      return loadJson('rules/cosmetic/site.json').then(function (site) {
        var host = String(msg.host || '');
        var genP = B.needsGeneric(host, site) ? loadJson('rules/cosmetic/generic.json') : Promise.resolve(null);
        return genP.then(function (generic) {
          var out = B.cssForHost(host, site, generic, { ads: b.ads, cookies: b.hideCookieBanners });
          if (!out.css) return { cookieSelectors: [] };
          return chrome.scripting.insertCSS({ target: { tabId: tabId, frameIds: [frameId] }, css: out.css, origin: 'USER' }).then(function () {
            log.debug('site CSS for', host, out.selectors, 'selectors');
            return { cookieSelectors: out.cookieSelectors };
          });
        });
      });
    }).then(sendResponse, function (e) {
      log.debug('site CSS failed', e && e.message);
      sendResponse({ cookieSelectors: [] });
    });
    return true;
  }

  // ---------------------------------------------------------------- autoconsent
  var AC_TYPES = ['init', 'eval', 'visualDelay', 'cmpDetected', 'popupFound', 'optOutResult', 'optInResult',
    'selfTestResult', 'autoconsentDone', 'autoconsentError', 'report'];

  function acConfig(enabled) {
    return {
      enabled: enabled,
      autoAction: 'optOut',
      disabledCmps: [],
      enablePrehide: true,
      enableCosmeticRules: true,
      enableGeneratedRules: true,
      enableHeuristicDetection: false,
      enablePopupMutationObserver: false,
      detectRetries: 20,
      isMainWorld: false,
      prehideTimeout: 2000,
      visualTest: false,
      logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: !!state.settings.debug, messages: false, waits: false },
      performanceLoggingEnabled: false,
      heuristicPopupSearchTimeout: 100,
      enableHeuristicHitTest: false,
      heuristicMode: 'off'
    };
  }

  function toFrame(tabId, frameId, msg) {
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId: frameId }).catch(function () {});
    } catch (e) { /* tab gone */ }
  }

  function onAutoconsent(msg, sender) {
    var tabId = sender.tab.id;
    var frameId = sender.frameId || 0;
    switch (msg.type) {
      case 'init':
        readState().then(function (st) {
          var on = !!AC && st.settings.enabled && st.blocking.autoRejectCookies && !allowedHere(sender);
          if (!on) return { type: 'initResp', rules: { autoconsent: [] }, config: acConfig(false) };
          return loadJson('vendor/autoconsent/compact-rules.json').then(function (rules) {
            var compact = AC.filterCompactRules(rules, { url: sender.url || '', mainFrame: frameId === 0 });
            return { type: 'initResp', rules: { autoconsent: [], compact: compact }, config: acConfig(true) };
          });
        }).then(function (resp) { toFrame(tabId, frameId, resp); }, function (e) {
          log.warn('autoconsent init failed', e && e.message);
        });
        return;
      case 'eval': {
        var fn = AC && AC.evalSnippets && Object.prototype.hasOwnProperty.call(AC.evalSnippets, msg.snippetId) ? AC.evalSnippets[msg.snippetId] : null;
        var answer = function (result) { toFrame(tabId, frameId, { type: 'evalResp', id: msg.id, result: result }); };
        if (!fn) { answer(false); return; }
        chrome.scripting.executeScript({ target: { tabId: tabId, frameIds: [frameId] }, world: 'MAIN', func: fn }).then(function (res) {
          answer(res && res[0] ? res[0].result : false);
        }, function () { answer(false); });
        return;
      }
      case 'autoconsentDone':
        log.debug('cookie pop-up handled:', msg.cmp, msg.isCosmetic ? '(hidden)' : '(rejected)');
        updatePage(tabId, function (p) { p.rejected = (p.rejected || 0) + 1; return p; });
        return;
      case 'autoconsentError':
        log.debug('autoconsent error', JSON.stringify(msg.details));
        return;
      default:
        return; // optOutResult, report, ...: nothing to do (autoAction is set)
    }
  }

  // ---------------------------------------------------------------- listeners
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return false;
    if (!sender.tab || typeof sender.tab.id !== 'number') return false;
    if (msg.type === 'as-page') return onPage(msg, sender, sendResponse);
    if (msg.type === 'as-banner') {
      updatePage(sender.tab.id, function (p) { p.hidden = (p.hidden || 0) + 1; return p; });
      return false;
    }
    if (AC_TYPES.indexOf(msg.type) !== -1) onAutoconsent(msg, sender);
    return false;
  });

  // autoconsent's content script opens a port named "instance-<id>" (used by its devtools
  // panel). Accept and close it: without a listener its connect() logs "Receiving end does not
  // exist" in every page, and holding it open would only keep the worker awake.
  if (chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener(function (port) {
      if (port && typeof port.name === 'string' && port.name.indexOf('instance-') === 0) {
        try { port.disconnect(); } catch (e) { /* already gone */ }
      }
    });
  }

  chrome.runtime.onInstalled.addListener(function () {
    // Force re-registration after an update (file lists may have changed).
    chrome.storage.local.remove(SIG_KEY).then(apply, apply);
  });
  chrome.runtime.onStartup.addListener(function () { apply(); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY])) apply();
  });
  chrome.tabs.onRemoved.addListener(function (tabId) {
    enqueue(function () { return chrome.storage.session.remove(pageKey(tabId)); });
  });

  apply();
  ns.general = { apply: apply };
})();
