/*
 * Background part of the general (all-sites) blocker. Loaded by service-worker.js with
 * importScripts after config.js, settings.js, logger.js, blocking.js, lists.js and the vendored
 * autoconsent library (vendor/autoconsent/autoconsent.cjs.js via autoconsent-shim.js).
 *
 *  - owns every declarativeNetRequest change of the general blocker, in one queue (syncDnr):
 *    the generated static rulesets (ads_N, ads_curated, privacy_N, privacy_curated, cookies_N,
 *    cookie_strip) via blocking.rulesetPlan, one dynamic allowAllRequests rule for the per-site
 *    allowlist, and the dynamic rules of updated filter lists (chrome.storage.local "listRules",
 *    written by updater.js through installLists / resetLists). A category with dynamic rules
 *    installed has its list rulesets (ads_N, privacy_N, cookies_N) disabled;
 *  - registers the cosmetic CSS / small page script / autoconsent content scripts and our MAIN-world
 *    scriptlets (build/scriptlets-main.js, hosts from rules/scriptlets.json) with
 *    chrome.scripting.registerContentScripts (only when the plan changed);
 *  - injects per-site cosmetic CSS (chrome.scripting.insertCSS, USER origin) when the page
 *    script says hello, plus the user's own "My filters" selectors for the site
 *    (chrome.storage.local "userFilters", src/shared/userfilters.js), and counts "banner hidden"
 *    / autoconsent opt-outs per page;
 *  - saves a selector from the element picker (src/content/picker.js, message as-picker-save)
 *    and applies it to the tab at once;
 *  - answers the autoconsent content script's messages (init / eval / autoconsentDone ...),
 *    following the protocol documented in autoconsent's docs/api.md.
 * It makes no network requests itself (updater.js downloads the lists); site cosmetic data comes
 * from the updated lists in chrome.storage.local "listSite" when present, else from the package.
 */
/* global chrome */
(function () {
  'use strict';
  var ns = self.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
  var U = ns.userFilters;
  var L = ns.lists;
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

  // Site cosmetic data: the updated lists' copy (storage) wins over rules/cosmetic/site.json.
  var siteCache = null;
  function loadSite() {
    if (!siteCache) {
      siteCache = chrome.storage.local.get(L.SITE_KEY).then(function (r) {
        var s = r[L.SITE_KEY];
        return s && typeof s === 'object' && s.v === 1 ? s : loadJson('rules/cosmetic/site.json');
      });
      siteCache.catch(function () { siteCache = null; });
    }
    return siteCache;
  }

  function readState() {
    return chrome.storage.local.get([S.STORAGE_KEY, B.STORAGE_KEY]).then(function (r) {
      state = { settings: S.normalize(r[S.STORAGE_KEY]), blocking: B.normalize(r[B.STORAGE_KEY]) };
      return state;
    });
  }

  function readUserFilters() {
    return chrome.storage.local.get(U.STORAGE_KEY).then(function (r) { return U.normalize(r[U.STORAGE_KEY]); });
  }

  function readListRules() {
    return chrome.storage.local.get(L.RULES_KEY).then(function (r) {
      var v = r[L.RULES_KEY];
      return v && typeof v === 'object' ? v : null;
    });
  }

  function staticRulesetIds() {
    var dnr = chrome.runtime.getManifest().declarative_net_request || {};
    return (dnr.rule_resources || []).map(function (r) { return r.id; });
  }

  function setRulesets(plan) {
    return chrome.declarativeNetRequest.updateEnabledRulesets(plan).catch(function (e) {
      // Over the static rule limit: say so, keep going with the rest.
      log.error('updateEnabledRulesets failed', e && e.message);
    });
  }

  function dynamicIds() {
    return chrome.declarativeNetRequest.getDynamicRules().then(function (rules) {
      return (rules || []).map(function (r) { return r.id; });
    });
  }

  function activeOf(ids) {
    var c = B.dynamicCounts(ids), a = {};
    B.DYNAMIC_FEATURES.forEach(function (f) { a[f] = c[f] > 0; });
    return a;
  }

  /**
   * Bring the general blocker's DNR state in line with the settings.
   * stored: chrome.storage.local "listRules" ({feature: [dynamic rules]}) or null.
   * replace: {feature: true} forces those categories to be re-installed (new list versions).
   * Order avoids gaps: list rulesets of categories that stay or become static are enabled first,
   * then one atomic updateDynamicRules (allowlist + every category that changes), then the list
   * rulesets of categories whose dynamic rules are now in place are disabled. If the dynamic
   * update fails, the previous dynamic rules stay (the call is atomic), the allowlist rule is
   * applied alone and the static plan follows what is actually installed.
   * Resolves { ok, error, active: {feature: bool} }.
   */
  function syncDnr(st, stored, replace) {
    var ids = staticRulesetIds();
    var on = st.settings.enabled;
    var b = st.blocking;
    return dynamicIds().then(function (cur) {
      var before = activeOf(cur);
      var want = {}, keep = {};
      B.DYNAMIC_FEATURES.forEach(function (f) {
        want[f] = !!(on && b[f] && stored && Array.isArray(stored[f]) && stored[f].length);
        keep[f] = before[f] && want[f] && !(replace && replace[f]);
      });
      var pre = B.rulesetPlan(ids, on, b, keep);
      var allowRules = B.allowlistRules(on, b.allowlist);
      var remove = [B.ALLOWLIST_RULE_ID], add = allowRules.slice();
      var counts = B.dynamicCounts(cur);
      B.DYNAMIC_FEATURES.forEach(function (f) {
        var need = want[f] ? stored[f].length : 0;
        if (!(replace && replace[f]) && counts[f] === need) return;
        cur.forEach(function (id) { if (B.dynamicFeature(id) === f) remove.push(id); });
        if (want[f]) add = add.concat(stored[f]);
      });
      return setRulesets(pre).then(function () {
        return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: remove, addRules: add });
      }).then(function () {
        return { ok: true, error: null };
      }, function (e) {
        var msg = (e && e.message) || String(e);
        log.error('updateDynamicRules failed', msg);
        return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [B.ALLOWLIST_RULE_ID], addRules: allowRules })
          .catch(function (e2) { log.error('allowlist rule failed', e2 && e2.message); })
          .then(function () { return { ok: false, error: msg }; });
      }).then(function (res) {
        return dynamicIds().then(function (after) {
          res.active = activeOf(after);
          var post = B.rulesetPlan(ids, on, b, res.active);
          if (JSON.stringify(post) === JSON.stringify(pre)) return res;
          return setRulesets(post).then(function () { return res; });
        });
      });
    });
  }

  /**
   * Install freshly converted lists (updater.js): replaces every category's dynamic rules in one
   * atomic call and only then stores rules, site data and metadata. Rejects (storage untouched)
   * when Chrome refuses the rules.
   */
  function installLists(data) {
    return enqueue(function () {
      return readState().then(function (st) {
        var all = {};
        B.DYNAMIC_FEATURES.forEach(function (f) { all[f] = true; });
        return syncDnr(st, data.rules, all);
      }).then(function (res) {
        if (!res.ok) throw new Error(res.error || 'updateDynamicRules failed');
        var o = {};
        o[L.RULES_KEY] = data.rules;
        o[L.SITE_KEY] = data.site;
        o[L.META_KEY] = data.meta;
        siteCache = null;
        return chrome.storage.local.set(o).then(function () { return syncScripts(state); }).then(function () { return res; });
      });
    });
  }

  /** Back to the packaged lists: drop stored rules and site data, re-enable the static rulesets. */
  function resetLists(meta) {
    return enqueue(function () {
      var o = {};
      o[L.META_KEY] = meta;
      return chrome.storage.local.remove([L.RULES_KEY, L.SITE_KEY]).then(function () {
        siteCache = null;
        return chrome.storage.local.set(o);
      }).then(readState).then(function (st) {
        return syncDnr(st, null, null).then(function (res) {
          return syncScripts(st).then(function () { return res; });
        });
      });
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
    var siteP = needSite ? loadSite().catch(function () { return null; }) : Promise.resolve(null);
    // Hosts of our packaged page-script rules (build/scriptlets-main.js runs only there).
    var needSl = st.settings.enabled && st.blocking.ads && st.blocking.scriptlets;
    var slP = needSl ? loadJson('rules/scriptlets.json').then(B.scriptletHosts, function () { return []; }) : Promise.resolve([]);
    var ufP = st.settings.enabled ? readUserFilters().then(U.hosts, function () { return []; }) : Promise.resolve([]);
    return Promise.all([siteP, chrome.storage.local.get(SIG_KEY), chrome.scripting.getRegisteredContentScripts(), slP, ufP]).then(function (res) {
      var plan = B.contentScriptPlan(st.settings.enabled, st.blocking, B.cosmeticExcludeHosts(res[0]), res[3], res[4]);
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
        return Promise.all([readListRules().then(function (stored) { return syncDnr(st, stored, null); }), syncScripts(st)]);
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
    var none = { css: '', selectors: 0, cookieSelectors: [] };
    readState().then(function (st) {
      var b = st.blocking;
      if (!st.settings.enabled || allowedHere(sender)) return { cookieSelectors: [] };
      var host = String(msg.host || '');
      // User filters apply whenever the master switch is on and the site is not allowlisted,
      // whatever the Ads / Cookie-banner switches say (they are the user's own choice).
      var userP = readUserFilters().then(function (uf) { return U.cssFor(host, uf); }, function () { return ''; });
      var siteP = !(b.ads || b.hideCookieBanners) ? Promise.resolve(none) : loadSite().then(function (site) {
        var genP = B.needsGeneric(host, site) ? loadJson('rules/cosmetic/generic.json') : Promise.resolve(null);
        return genP.then(function (generic) {
          return B.cssForHost(host, site, generic, { ads: b.ads, cookies: b.hideCookieBanners });
        });
      });
      return Promise.all([siteP, userP]).then(function (res) {
        var out = res[0], css = [out.css, res[1]].filter(Boolean).join('\n');
        if (!css) return { cookieSelectors: [] };
        return chrome.scripting.insertCSS({ target: { tabId: tabId, frameIds: [frameId] }, css: css, origin: 'USER' }).then(function () {
          log.debug('site CSS for', host, out.selectors, 'selectors', res[1] ? '+ my filters' : '');
          return { cookieSelectors: out.cookieSelectors };
        });
      });
    }).then(sendResponse, function (e) {
      log.debug('site CSS failed', e && e.message);
      sendResponse({ cookieSelectors: [] });
    });
    return true;
  }

  // ---------------------------------------------------------------- element picker
  /**
   * as-picker-save { selector } from src/content/picker.js (top frame of a web page). The site
   * is taken from the sender's tab URL, not from the message. The selector gets the conservative
   * syntax check (the picker already ran querySelectorAll on it), is stored under
   * siteKey(host) and inserted into the tab at once. Resolves { ok, error }.
   */
  function onPickerSave(msg, sender, sendResponse) {
    var tabId = sender.tab.id;
    var host = B.siteKey(topHost(sender));
    if ((sender.frameId || 0) !== 0 || !host) { sendResponse({ ok: false, error: 'Not a web page.' }); return false; }
    var sel = typeof msg.selector === 'string' ? msg.selector.trim() : '';
    enqueue(function () {
      return chrome.storage.local.get(U.STORAGE_KEY).then(function (r) {
        var res = U.add(r[U.STORAGE_KEY], host, sel);
        if (!res.ok) return { ok: false, error: res.error };
        var o = {};
        o[U.STORAGE_KEY] = res.value;
        return chrome.storage.local.set(o).then(function () { return { ok: true, error: null }; });
      });
    }).then(function (res) {
      if (!res.ok) return res;
      return readState().then(function (st) {
        if (!st.settings.enabled || allowedHere(sender)) return res;
        return chrome.scripting.insertCSS({ target: { tabId: tabId, frameIds: [0] }, css: sel + '{display:none!important}', origin: 'USER' })
          .then(function () { return res; }, function () { return res; });
      });
    }).then(function (res) {
      log.debug('picker saved', host, sel, res.ok ? 'ok' : res.error);
      sendResponse(res);
    }, function (e) {
      sendResponse({ ok: false, error: (e && e.message) || 'Could not save.' });
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
    if (msg.type === 'as-picker-save') return onPickerSave(msg, sender, sendResponse);
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
    if (area === 'local' && changes[L.SITE_KEY]) siteCache = null;
    if (area === 'local' && (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY])) apply();
    // New or removed "My filters" hosts change where the page script must run.
    else if (area === 'local' && changes[U.STORAGE_KEY]) enqueue(function () { return readState().then(syncScripts); });
  });
  chrome.tabs.onRemoved.addListener(function (tabId) {
    enqueue(function () { return chrome.storage.session.remove(pageKey(tabId)); });
  });

  apply();
  ns.general = { apply: apply, installLists: installLists, resetLists: resetLists };
})();
