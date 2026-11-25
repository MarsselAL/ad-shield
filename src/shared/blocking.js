/*
 * General (all-sites) blocking: settings, per-site allowlist, and the pure planning functions the
 * background uses (which rulesets to enable, which content scripts to register, which CSS a host
 * gets, how matched DNR rules are counted). No chrome.* or DOM use, so it runs in the background,
 * popup, options page, the ISOLATED-world bundle and the jsc tests.
 * Stored separately from the Twitch settings (chrome.storage.local key "blocking"); the master
 * switch is still settings.enabled (src/shared/settings.js).
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};

  var STORAGE_KEY = 'blocking';
  var MAX_ALLOWLIST = 1000;
  // Must equal ALLOW_ID_BASE in tools/filterlist.py: allow rules have ids >= this.
  var ALLOW_ID_BASE = 500000;
  var ALLOWLIST_RULE_ID = 1;
  var ALLOWLIST_PRIORITY = 100;     // above every static rule (static priorities are 1..4)
  var TWITCH_RULESETS = ['client_ads', 'trackers'];
  // Dynamic rules from the weekly list update (src/background/updater.js): rule id = base +
  // static id, so block rules sit at base+1.. and allow rules at base+500001.. (ALLOW_ID_BASE).
  var DYNAMIC_BASES = { ads: 1000000, trackers: 2000000, hideCookieBanners: 3000000 };
  var DYNAMIC_SPAN = 1000000;
  var DYNAMIC_FEATURES = ['ads', 'trackers', 'hideCookieBanners'];
  var SCRIPT_PREFIX = 'as-';
  var WEB = ['http://*/*', 'https://*/*'];
  // Our own YouTube cosmetic CSS (rules/cosmetic/youtube.css) is registered for these sites only.
  var YOUTUBE_CSS_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com'];

  function defaults() {
    return {
      ads: true,                 // EasyList network rules + cosmetic hiding
      trackers: true,            // EasyPrivacy network rules
      stripCookies: true,        // remove Cookie / Set-Cookie on third-party tracker requests
      hideCookieBanners: true,   // EasyList Cookie List network rules + cosmetic hiding
      autoRejectCookies: false,  // DuckDuckGo autoconsent: click "reject" on consent pop-ups
      autoUpdateLists: true,     // weekly download of the three filter lists (updater.js)
      scriptlets: true,          // our page scripts (rules/scriptlets.json, e.g. YouTube); needs ads on
      stripTrackingParams: true, // remove utm_*, fbclid, gclid ... from page / frame URLs (rules/removeparam.json)
      allowlist: []              // sites where all of the above (and the Twitch module) are off
    };
  }

  var HOST_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
  var IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  /** "https://www.Example.com:8080/x" / "*.example.com" / "example.com." -> "example.com" or null. */
  function normalizeHost(input) {
    if (typeof input !== 'string') return null;
    var s = input.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0];
    s = s.replace(/^[^@]*@/, '');
    s = s.replace(/:\d*$/, '');
    s = s.replace(/^\*\./, '').replace(/\.$/, '');
    if (/[^\x00-\x7f]/.test(s)) {
      if (typeof URL !== 'function') return null;
      try { s = new URL('http://' + s + '/').hostname; } catch (e) { return null; }
    }
    if (!s || s.length > 253 || !HOST_RE.test(s)) return null;
    return s;
  }

  /** The allowlist key for a page host: the host without a leading "www.". */
  function siteKey(hostname) {
    var h = normalizeHost(hostname);
    if (!h) return null;
    return h.indexOf('www.') === 0 && h.length > 4 ? h.slice(4) : h;
  }

  function covers(entry, host) {
    return host === entry || (host.length > entry.length && host.slice(-(entry.length + 1)) === '.' + entry);
  }

  function isAllowlisted(hostname, list) {
    var h = normalizeHost(hostname);
    if (!h || !Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) if (covers(list[i], h)) return true;
    return false;
  }

  function cleanList(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) {
      var h = normalizeHost(x);
      if (h && !seen[h]) { seen[h] = true; out.push(h); }
    });
    out.sort();
    return out.slice(0, MAX_ALLOWLIST);
  }

  /** Parse the options-page textarea (one site per line, or comma/space separated). */
  function parseAllowlistText(text) {
    var errors = [];
    var items = String(text || '').split(/[\s,]+/).filter(Boolean);
    var good = [];
    items.forEach(function (x) {
      var h = normalizeHost(x);
      if (!h) errors.push('Not a valid site: "' + x + '".');
      else good.push(h);
    });
    if (good.length > MAX_ALLOWLIST) errors.push('At most ' + MAX_ALLOWLIST + ' sites.');
    return { ok: errors.length === 0, value: errors.length ? null : cleanList(good), errors: errors };
  }

  /** Stored (possibly corrupt) value -> valid settings; never throws. */
  function normalize(stored) {
    var d = defaults();
    var s = stored && typeof stored === 'object' ? stored : {};
    var out = {};
    Object.keys(d).forEach(function (k) {
      if (k === 'allowlist') out.allowlist = cleanList(s.allowlist);
      else out[k] = typeof s[k] === 'boolean' ? s[k] : d[k];
    });
    return out;
  }

  /**
   * New allowlist after the popup's per-site switch. allowed=true (blocking off on this site)
   * adds siteKey(host); allowed=false removes every entry that covers the host.
   */
  function setSiteAllowed(list, hostname, allowed) {
    var cur = cleanList(list);
    var h = normalizeHost(hostname);
    if (!h) return cur;
    if (allowed) {
      if (isAllowlisted(h, cur)) return cur;
      return cleanList(cur.concat([siteKey(h)]));
    }
    return cur.filter(function (e) { return !covers(e, h); });
  }

  // ---------------------------------------------------------------- rulesets
  /**
   * Category of a static ruleset id; null for rulesets this module does not own.
   * ads_N / privacy_N come from EasyList / EasyPrivacy, ads_curated / privacy_curated from our
   * own rules/curated_hosts.txt; both follow the same switch and count in the same bucket.
   * youtube is our hand-written rules/youtube.json (two YouTube ad paths, plus the watch-page
   * pp=oAEBogYBLg redirect and its loop-guard allow rule), part of Ads.
   * removeparam (rules/removeparam.json, from our rules/removeparams.txt) redirects pages and
   * frames to the same URL without tracking parameters; never counted in the popup.
   */
  function rulesetFeature(id) {
    if (id === 'removeparam') return 'stripTrackingParams';
    if (/^ads_(\d+|curated)$/.test(id) || id === 'youtube') return 'ads';
    if (/^privacy_(\d+|curated)$/.test(id)) return 'trackers';
    if (/^cookies_\d+$/.test(id)) return 'hideCookieBanners';
    if (id === 'cookie_strip') return 'stripCookies';
    return null;
  }

  /** True for the rulesets generated from the lists (ads_N, privacy_N, cookies_N), which the
   * weekly update replaces with dynamic rules; not the curated ones or cookie_strip. */
  function isListRuleset(id) {
    return /^(ads|privacy|cookies)_\d+$/.test(id);
  }

  /**
   * { enableRulesetIds, disableRulesetIds } for the general rulesets among `ids`.
   * dynamic: { ads, trackers, hideCookieBanners } -> true when that category's updated lists are
   * installed as dynamic rules; its list rulesets are then disabled (curated / cookie_strip stay).
   */
  function rulesetPlan(ids, masterEnabled, b, dynamic) {
    var enable = [], disable = [];
    var dyn = dynamic || {};
    (ids || []).forEach(function (id) {
      var f = rulesetFeature(id);
      if (!f) return;
      var on = masterEnabled && b[f] && !(isListRuleset(id) && dyn[f]);
      (on ? enable : disable).push(id);
    });
    return { enableRulesetIds: enable, disableRulesetIds: disable };
  }

  /** Feature ('ads' | 'trackers' | 'hideCookieBanners') owning a dynamic rule id, or null. */
  function dynamicFeature(ruleId) {
    if (typeof ruleId !== 'number') return null;
    for (var i = 0; i < DYNAMIC_FEATURES.length; i++) {
      var base = DYNAMIC_BASES[DYNAMIC_FEATURES[i]];
      if (ruleId > base && ruleId < base + DYNAMIC_SPAN) return DYNAMIC_FEATURES[i];
    }
    return null;
  }

  /** Dynamic rule ids -> { ads: n, trackers: n, hideCookieBanners: n } (installed rule counts). */
  function dynamicCounts(ruleIds) {
    var c = { ads: 0, trackers: 0, hideCookieBanners: 0 };
    (ruleIds || []).forEach(function (id) {
      var f = dynamicFeature(id);
      if (f) c[f]++;
    });
    return c;
  }

  /** Dynamic rules for the allowlist: one allowAllRequests rule covering every listed site. */
  function allowlistRules(masterEnabled, list) {
    var l = cleanList(list);
    if (!masterEnabled || !l.length) return [];
    return [{
      id: ALLOWLIST_RULE_ID,
      priority: ALLOWLIST_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: l, resourceTypes: ['main_frame', 'sub_frame'] }
    }];
  }

  /** rules/youtube.json rules that block nothing: the watch-page pp redirect (rule 3) is not
   * counted as an ad (its loop-guard allow rule, 500001, is in the allow id range). */
  var YOUTUBE_UNCOUNTED_RULE_IDS = [3];

  /** Popup counts from chrome.declarativeNetRequest.getMatchedRules().rulesMatchedInfo.
   * Tracking-parameter redirects (removeparam) and the YouTube pp rules are not counted. */
  function countMatches(infos) {
    var c = { ads: 0, trackers: 0, cookies: 0, banners: 0 };
    (infos || []).forEach(function (m) {
      var r = m && m.rule;
      if (!r || typeof r.ruleId !== 'number') return;
      if (r.rulesetId === '_dynamic') {
        // Updated lists (allowlist rule 1 and allow-rule ranges are not counted).
        var df = dynamicFeature(r.ruleId);
        if (!df || r.ruleId - DYNAMIC_BASES[df] >= ALLOW_ID_BASE) return;
        if (df === 'ads') c.ads++;
        else if (df === 'trackers') c.trackers++;
        else c.banners++;
        return;
      }
      if (r.ruleId >= ALLOW_ID_BASE) return;
      var id = r.rulesetId;
      if (id === 'youtube' && YOUTUBE_UNCOUNTED_RULE_IDS.indexOf(r.ruleId) !== -1) return;
      if (id === 'trackers') { c.trackers++; return; }
      var f = rulesetFeature(id);
      if (f === 'ads') c.ads++;
      else if (f === 'trackers') c.trackers++;
      else if (f === 'stripCookies') c.cookies++;
      else if (f === 'hideCookieBanners') c.banners++;
    });
    return c;
  }

  // ---------------------------------------------------------------- content scripts
  /** Match pattern(s) for a host and its subdomains; [] for hosts a pattern cannot express. */
  function hostPatterns(host) {
    if (typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host) || host.charAt(0) === '.') return [];
    if (IPV4_RE.test(host)) return ['*://' + host + '/*'];
    return ['*://*.' + host + '/*'];
  }

  function patternsFor(hosts) {
    var out = [];
    (hosts || []).forEach(function (h) { out.push.apply(out, hostPatterns(h)); });
    return out;
  }

  /** Sorted unique hosts of rules/scriptlets.json ({ rules: [{ hosts: [...] }] }); [] if malformed. */
  function scriptletHosts(table) {
    var seen = {};
    var rules = table && Array.isArray(table.rules) ? table.rules : [];
    rules.forEach(function (r) {
      (r && Array.isArray(r.hosts) ? r.hosts : []).forEach(function (h) {
        var n = normalizeHost(h);
        if (n && n === h && hostPatterns(n).length) seen[n] = true;
      });
    });
    return Object.keys(seen).sort();
  }

  /**
   * Content scripts to register (chrome.scripting.registerContentScripts format).
   * cosmeticExcludeHosts: hosts with generic-hiding exceptions; they get the generic CSS from the
   * background instead (minus the exceptions), so the static CSS file skips them.
   * slHosts: scriptletHosts(rules/scriptlets.json); build/scriptlets-main.js runs only there
   * (MAIN world, every frame whose URL matches), while Ads and Page scripts are both on. No
   * matchOriginAsFallback: YouTube appends a sandboxed about:blank iframe (sandbox="allow-same-origin",
   * no allow-scripts) and Chrome logged "Blocked script execution in 'about:blank' ..." for our
   * script there. Same-origin about:blank children are still patched from the parent through
   * protectFrames (src/scriptlets/runner.js) and prevent-dom-bypass.
   * userHosts: hosts with "My filters" (src/shared/userfilters.js). The page script asks the
   * background for their CSS, so with Ads and Cookie banners both off it still runs there.
   */
  function contentScriptPlan(masterEnabled, b, cosmeticExcludeHosts, slHosts, userHosts) {
    if (!masterEnabled) return [];
    var allow = patternsFor(b.allowlist);
    var cssExclude = allow.concat(patternsFor(cosmeticExcludeHosts));
    var plan = [];
    function css(id, file) {
      var o = { id: id, css: [file], matches: WEB.slice(), allFrames: true, runAt: 'document_start', persistAcrossSessions: true };
      if (cssExclude.length) o.excludeMatches = cssExclude.slice();
      plan.push(o);
    }
    function js(id, file, allFrames, matches) {
      var o = { id: id, js: [file], matches: matches || WEB.slice(), allFrames: allFrames, runAt: 'document_start', persistAcrossSessions: true };
      if (allFrames) o.matchOriginAsFallback = true;
      if (allow.length) o.excludeMatches = allow.slice();
      plan.push(o);
    }
    if (b.ads) css('as-css-ads', 'rules/cosmetic/ads_generic.css');
    if (b.hideCookieBanners) css('as-css-cookies', 'rules/cosmetic/cookies_generic.css');
    var userMatches = patternsFor(userHosts);
    if (b.ads || b.hideCookieBanners) js('as-site', 'src/content/general.js', false);
    else if (userMatches.length) js('as-site', 'src/content/general.js', false, userMatches);
    if (b.autoRejectCookies) js('as-autoconsent', 'vendor/autoconsent/content.bundle.js', true);
    if (b.ads) {
      var yt = { id: 'as-css-youtube', css: ['rules/cosmetic/youtube.css'], matches: patternsFor(YOUTUBE_CSS_HOSTS), allFrames: true, runAt: 'document_start', persistAcrossSessions: true };
      if (allow.length) yt.excludeMatches = allow.slice();
      plan.push(yt);
    }
    var slm = patternsFor(slHosts);
    if (b.ads && b.scriptlets && slm.length) {
      var sl = {
        id: 'as-scriptlets', js: ['build/scriptlets-main.js'], matches: slm, world: 'MAIN', allFrames: true,
        runAt: 'document_start', persistAcrossSessions: true
      };
      if (allow.length) sl.excludeMatches = allow.slice();
      plan.push(sl);
    }
    return plan;
  }

  // ---------------------------------------------------------------- per-site CSS
  /** "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]. */
  function hostCandidates(host) {
    var h = normalizeHost(host);
    if (!h) return [];
    var parts = h.split('.'), out = [];
    for (var i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
    return out;
  }

  function anyIn(cands, list) {
    if (!list) return false;
    for (var i = 0; i < cands.length; i++) if (list.indexOf(cands[i]) !== -1) return true;
    return false;
  }

  /**
   * CSS the background injects into a page of `host`.
   * site: rules/cosmetic/site.json; generic: rules/cosmetic/generic.json or null (only needed
   * when needsGeneric() is true); on: { ads, cookies } feature switches.
   * Returns { css, selectors, cookieSelectors } (cookieSelectors: site-specific cookie selectors,
   * for the one-time "banner hidden" check in the page).
   */
  function cssForHost(host, site, generic, on) {
    var empty = { css: '', selectors: 0, cookieSelectors: [] };
    var cands = hostCandidates(host);
    if (!cands.length || !site || anyIn(cands, site.elemhide)) return empty;
    var exc = {};
    cands.forEach(function (c) { ((site.exceptions || {})[c] || []).forEach(function (s) { exc[s] = true; }); });
    var picked = [], seen = {}, cookieSel = [];
    function add(sel, isCookie) {
      if (exc[sel] || seen[sel]) return;
      seen[sel] = true;
      picked.push(sel);
      if (isCookie) cookieSel.push(sel);
    }
    var cats = [];
    if (on.ads) cats.push('ads');
    if (on.cookies) cats.push('cookies');
    cats.forEach(function (cat) {
      var map = site[cat] || {};
      cands.forEach(function (c) { (map[c] || []).forEach(function (s) { add(s, cat === 'cookies'); }); });
    });
    if (generic && needsGeneric(host, site)) {
      cats.forEach(function (cat) { (generic[cat] || []).forEach(function (s) { add(s, false); }); });
    }
    return {
      css: picked.map(function (s) { return s + '{display:none!important}'; }).join('\n'),
      selectors: picked.length,
      cookieSelectors: cookieSel.slice(0, 50)
    };
  }

  /** True when the static generic CSS skips this host and the background must inject it. */
  function needsGeneric(host, site) {
    var cands = hostCandidates(host);
    if (!site || anyIn(cands, site.generichide) || anyIn(cands, site.elemhide)) return false;
    return anyIn(cands, site.genericExceptionHosts);
  }

  /** Hosts the static generic CSS must not run on. */
  function cosmeticExcludeHosts(site) {
    if (!site) return [];
    var all = {};
    ['genericExceptionHosts', 'generichide', 'elemhide'].forEach(function (k) {
      (site[k] || []).forEach(function (h) { all[h] = true; });
    });
    return Object.keys(all).sort();
  }

  /** What the popup shows for the active tab's URL. */
  function popupSite(o) {
    var m = /^(https?):\/\/([^/:?#]+)/i.exec(String((o && o.url) || ''));
    var hostname = m ? normalizeHost(m[2]) : null;
    if (!hostname) {
      return { web: false, hostname: '', host: '', on: false, detail: 'Ad Shield does not run on this page.' };
    }
    var allowed = isAllowlisted(hostname, (o && o.allowlist) || []);
    var detail = o && o.enabled === false ? 'Ad Shield is switched off everywhere.'
      : allowed ? 'Blocking is off on this site.' : 'Blocking ads, trackers and cookie banners.';
    return { web: true, hostname: hostname, host: siteKey(hostname), on: !allowed, detail: detail };
  }

  ns.blocking = {
    popupSite: popupSite,
    STORAGE_KEY: STORAGE_KEY,
    ALLOW_ID_BASE: ALLOW_ID_BASE,
    ALLOWLIST_RULE_ID: ALLOWLIST_RULE_ID,
    TWITCH_RULESETS: TWITCH_RULESETS,
    DYNAMIC_BASES: DYNAMIC_BASES,
    DYNAMIC_SPAN: DYNAMIC_SPAN,
    DYNAMIC_FEATURES: DYNAMIC_FEATURES,
    isListRuleset: isListRuleset,
    dynamicFeature: dynamicFeature,
    dynamicCounts: dynamicCounts,
    SCRIPT_PREFIX: SCRIPT_PREFIX,
    defaults: defaults,
    normalize: normalize,
    normalizeHost: normalizeHost,
    siteKey: siteKey,
    isAllowlisted: isAllowlisted,
    parseAllowlistText: parseAllowlistText,
    setSiteAllowed: setSiteAllowed,
    rulesetFeature: rulesetFeature,
    rulesetPlan: rulesetPlan,
    allowlistRules: allowlistRules,
    countMatches: countMatches,
    YOUTUBE_UNCOUNTED_RULE_IDS: YOUTUBE_UNCOUNTED_RULE_IDS,
    hostPatterns: hostPatterns,
    contentScriptPlan: contentScriptPlan,
    scriptletHosts: scriptletHosts,
    YOUTUBE_CSS_HOSTS: YOUTUBE_CSS_HOSTS,
    hostCandidates: hostCandidates,
    cssForHost: cssForHost,
    needsGeneric: needsGeneric,
    cosmeticExcludeHosts: cosmeticExcludeHosts
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
