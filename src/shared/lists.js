/*
 * Pure decisions for the weekly filter-list update (src/background/updater.js) and its status on
 * the options page: list URLs, version parsing and comparison, sanity checks, dynamic rule ids,
 * rule limits, when a check is due, when to fall back to the packaged lists. No chrome.*, no DOM.
 *
 * Storage (chrome.storage.local):
 *   lists      metadata { source: 'packaged'|'updated', lastCheck, lastResult: {ok, message, at},
 *              lists: { <key>: {version, fetchedAt, rules, ok, error} } }
 *   listRules  { ads: [...], trackers: [...], hideCookieBanners: [...] } converted rules with
 *              their dynamic ids, kept so a category switched off and on again can be re-added
 *              without a download
 *   listSite   marker { v: 2, n: <shards>, at } of the updated site-specific cosmetic data, stored
 *              like rules/cosmetic/site/: listSite/index (host lists for the content-script
 *              exclusions) and listSite/00 .. listSite/7f (blocking.splitSite shards), so a page
 *              reads one small key. Up to 2.0.3 it was the whole object ({ v: 1, ... }), which is
 *              still read (legacySite) until the next update replaces it.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};

  // Same URLs as LISTS in tools/build_rules.py. These are the only requests the extension makes.
  var LISTS = [
    { key: 'easylist', name: 'EasyList (ads)', url: 'https://easylist.to/easylist/easylist.txt', prefix: 'ads', feature: 'ads' },
    { key: 'easyprivacy', name: 'EasyPrivacy (trackers)', url: 'https://easylist.to/easylist/easyprivacy.txt', prefix: 'privacy', feature: 'trackers' },
    { key: 'easylist-cookie', name: 'EasyList Cookie List', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', prefix: 'cookies', feature: 'hideCookieBanners' }
  ];
  var META_KEY = 'lists';
  var RULES_KEY = 'listRules';
  var SITE_KEY = 'listSite';
  var SITE_INDEX_KEY = SITE_KEY + '/index';
  var DAY_MS = 24 * 3600 * 1000;
  var WEEK_MS = 7 * DAY_MS;
  var SLACK_MS = 3600 * 1000;         // an alarm may fire a little early
  var MIN_RULE_RATIO = 0.6;           // fresh list must give >= 60 % of the packaged rule count
  var MAX_BYTES = 15 * 1024 * 1024;
  var TIMEOUT_MS = 60000;
  var ALLOW_ID_BASE = 500000;
  var SAFE_ACTIONS = { block: true, allow: true, allowAllRequests: true, upgradeScheme: true };

  /** "202611140001" | "2026-11-12 20:50 UTC" | "14 Nov 2026 00:01 UTC" -> epoch ms (UTC) or null. */
  function parseVersion(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim(), m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s) ||
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (m) {
      var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      return isNaN(t) ? null : t;
    }
    if (!/[a-z]/i.test(s) || !/\d{4}/.test(s)) return null;
    var d = Date.parse(s);
    return isNaN(d) ? null : d;
  }

  /** 1 when a is newer than b, 0 same, -1 older; null when either cannot be parsed. */
  function compareVersions(a, b) {
    var x = parseVersion(a), y = parseVersion(b);
    if (x === null || y === null) return null;
    return x > y ? 1 : x < y ? -1 : 0;
  }

  /** rules/build-info.json -> { <key>: { version, rules } } (rules: sum of prefix_N rulesets). */
  function packagedLists(info) {
    var out = {};
    LISTS.forEach(function (L) {
      var li = (info && info.lists && info.lists[L.key]) || {};
      var n = 0;
      Object.keys((info && info.rulesets) || {}).forEach(function (id) {
        if (new RegExp('^' + L.prefix + '_\\d+$').test(id)) n += info.rulesets[id].rules || 0;
      });
      out[L.key] = { version: li.version || null, rules: n };
    });
    return out;
  }

  function isUpdated(meta) { return !!(meta && meta.source === 'updated' && meta.lists); }

  /** Versions in use now: the updated ones when source is 'updated', else the packaged ones. */
  function installedVersions(meta, packaged) {
    var out = {};
    LISTS.forEach(function (L) {
      var m = isUpdated(meta) && meta.lists[L.key];
      out[L.key] = m && m.version ? m.version : (packaged[L.key] && packaged[L.key].version) || null;
    });
    return out;
  }

  /**
   * Sanity check of one converted list (filterlist.convertLists().lists[key]).
   * Returns { error } or { newer: bool }.
   */
  function checkList(conv, packaged, installed) {
    if (!conv || !conv.version) return { error: 'no "! Version" or "! Last modified" header' };
    if (parseVersion(conv.version) === null) return { error: 'unknown version format "' + conv.version + '"' };
    var min = Math.ceil(MIN_RULE_RATIO * ((packaged && packaged.rules) || 0));
    var n = (conv.rules || []).length;
    if (n < min) return { error: 'only ' + n + ' rules (built-in lists have ' + packaged.rules + ')' };
    var cmp = installed ? compareVersions(conv.version, installed) : 1;
    if (cmp === null) cmp = 1;
    if (cmp < 0) return { error: 'version ' + conv.version + ' is older than the one in use (' + installed + ')' };
    return { newer: cmp > 0 };
  }

  /**
   * All-or-nothing decision over the three lists. checks: { <key>: checkList() result }.
   * Returns { apply, upToDate, errors: { <key>: message } }: apply only when every list passed
   * and at least one is newer than the version in use.
   */
  function decide(checks) {
    var errors = {}, anyNewer = false, bad = false;
    LISTS.forEach(function (L) {
      var c = checks[L.key];
      if (!c) { errors[L.key] = 'not checked'; bad = true; return; }
      if (c.error) { errors[L.key] = c.error; bad = true; return; }
      if (c.newer) anyNewer = true;
    });
    return { apply: !bad && anyNewer, upToDate: !bad && !anyNewer, errors: errors };
  }

  /** Static-style rules (ids 1.., 500001..) -> dynamic ids base + id. Throws on an id out of range. */
  function toDynamic(rules, base) {
    return (rules || []).map(function (r) {
      if (typeof r.id !== 'number' || r.id < 1 || r.id >= 2 * ALLOW_ID_BASE) throw new Error('rule id out of range: ' + r.id);
      return { id: base + r.id, priority: r.priority, action: r.action, condition: r.condition };
    });
  }

  /** Rule limits from chrome.declarativeNetRequest (Chrome 121+ constants, older fallbacks). */
  function limitsFrom(dnr) {
    var d = dnr || {};
    var dyn = d.MAX_NUMBER_OF_DYNAMIC_RULES || d.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 5000;
    return {
      dynamic: dyn,
      unsafe: d.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES || (d.MAX_NUMBER_OF_DYNAMIC_RULES ? 5000 : dyn),
      regex: d.MAX_NUMBER_OF_REGEX_RULES || 1000
    };
  }

  /** Error message when all categories together (plus `reserved` other rules) do not fit; else null. */
  function fitCheck(byFeature, limits, reserved) {
    var total = reserved || 0, unsafe = 0, regex = 0;
    Object.keys(byFeature || {}).forEach(function (f) {
      (byFeature[f] || []).forEach(function (r) {
        total++;
        if (!SAFE_ACTIONS[r.action && r.action.type]) unsafe++;
        if (r.condition && r.condition.regexFilter) regex++;
      });
    });
    if (total > limits.dynamic) return total + ' rules do not fit (this Chrome allows ' + limits.dynamic + ' dynamic rules)';
    if (unsafe > limits.unsafe) return unsafe + ' unsafe rules (max ' + limits.unsafe + ')';
    if (regex > limits.regex) return regex + ' regex rules (max ' + limits.regex + ')';
    return null;
  }

  /** Should an automatic check run now? (weekly; the first one once the lists in use are a week old). */
  function isDue(meta, packaged, now) {
    if (meta && typeof meta.lastCheck === 'number') return now - meta.lastCheck >= WEEK_MS - SLACK_MS;
    var inUse = installedVersions(meta, packaged), oldest = null, unknown = false;
    LISTS.forEach(function (L) {
      var t = parseVersion(inUse[L.key]);
      if (t === null) unknown = true;
      else if (oldest === null || t < oldest) oldest = t;
    });
    return unknown || now - oldest >= WEEK_MS;
  }

  /** After an extension update: drop the updated lists when a packaged one is newer. */
  function shouldRevert(meta, packaged) {
    if (!isUpdated(meta)) return false;
    return LISTS.some(function (L) {
      var m = meta.lists[L.key];
      var c = compareVersions(packaged[L.key] && packaged[L.key].version, m && m.version);
      return c === 1 || c === null;
    });
  }

  function selectorSet(generic) {
    var set = {};
    ['ads', 'cookies'].forEach(function (c) { ((generic && generic[c]) || []).forEach(function (s) { set[s] = true; }); });
    return set;
  }

  /**
   * Hosts whose exceptions hide packaged generic selectors must stay in genericExceptionHosts:
   * the generic CSS is not updated (it comes from the package), so add them to the fresh list.
   * genericFullHosts: the hosts among them whose exceptions hit a packaged generic selector that
   * is not in the packaged excepted files (rules/cosmetic/generic_excepted.json), so it sits in a
   * big generic file: those hosts skip every generic file and get the whole list minus their
   * exceptions. packagedExcepted null (not readable): every such host, the safe choice.
   */
  function addPackagedGenericExceptions(site, packagedGeneric, packagedExcepted) {
    var gen = selectorSet(packagedGeneric), exc = packagedExcepted ? selectorSet(packagedExcepted) : null;
    var hosts = {}, full = {};
    (site.genericExceptionHosts || []).forEach(function (h) { hosts[h] = true; });
    Object.keys(site.exceptions || {}).forEach(function (h) {
      site.exceptions[h].forEach(function (s) {
        if (!gen[s]) return;
        hosts[h] = true;
        if (!exc || !exc[s]) full[h] = true;
      });
    });
    var out = Object.assign({}, site);
    out.genericExceptionHosts = Object.keys(hosts).sort();
    out.genericFullHosts = Object.keys(full).sort();
    return out;
  }

  /** Site data stored whole by an older version ({ v: 1 }, no genericFullHosts): its exception
   * hosts were made against the old generic files, so all of them get the whole generic list. */
  function legacySite(s) {
    var out = Object.assign({}, s);
    if (!Array.isArray(out.genericFullHosts)) out.genericFullHosts = (out.genericExceptionHosts || []).slice();
    return out;
  }

  function siteShardStorageKey(name) {
    return SITE_KEY + '/' + name;
  }

  /** Metadata after a successful update. conv: filterlist.convertLists() result. */
  function successMeta(conv, counts, now) {
    var lists = {};
    LISTS.forEach(function (L) {
      var c = conv.lists[L.key];
      lists[L.key] = { version: c.version, fetchedAt: now, rules: counts[L.feature], ok: true, error: null };
    });
    return { source: 'updated', lastCheck: now, lastResult: { ok: true, message: 'Updated.', at: now }, lists: lists };
  }

  /** Metadata after a check that changed nothing (up to date or failed): keeps what is in use. */
  function checkedMeta(meta, now, ok, message, errors) {
    var old = meta && typeof meta === 'object' ? meta : {};
    var lists = {};
    var prev = old.lists || {};
    LISTS.forEach(function (L) {
      var p = Object.assign({}, prev[L.key] || {});
      p.ok = !(errors && errors[L.key]);
      p.error = (errors && errors[L.key]) || null;
      lists[L.key] = p;
    });
    return {
      source: old.source === 'updated' ? 'updated' : 'packaged',
      lastCheck: now,
      lastResult: { ok: ok, message: message, at: now },
      lists: lists
    };
  }

  /** Metadata after "Use built-in lists" or an automatic fall-back. */
  function packagedMeta(meta, now, message) {
    var old = meta && typeof meta === 'object' ? meta : {};
    return {
      source: 'packaged',
      lastCheck: typeof old.lastCheck === 'number' ? old.lastCheck : null,
      lastResult: { ok: true, message: message, at: now },
      lists: {}
    };
  }

  /** Rows for the options page: [{ key, name, version, updatedAt, rules, status, ok }]. */
  function statusRows(meta, packaged) {
    var upd = isUpdated(meta);
    return LISTS.map(function (L) {
      var m = (meta && meta.lists && meta.lists[L.key]) || {};
      var p = packaged[L.key] || {};
      var use = upd && m.version;
      var ok = m.ok !== false;
      return {
        key: L.key,
        name: L.name,
        version: use ? m.version : p.version,
        updatedAt: use ? m.fetchedAt : null,
        rules: use ? m.rules : p.rules,
        ok: ok,
        status: !ok ? 'last check failed: ' + m.error : use ? 'updated' : 'built in'
      };
    });
  }

  ns.lists = {
    LISTS: LISTS,
    META_KEY: META_KEY,
    RULES_KEY: RULES_KEY,
    SITE_KEY: SITE_KEY,
    SITE_INDEX_KEY: SITE_INDEX_KEY,
    siteShardStorageKey: siteShardStorageKey,
    legacySite: legacySite,
    WEEK_MS: WEEK_MS,
    MIN_RULE_RATIO: MIN_RULE_RATIO,
    MAX_BYTES: MAX_BYTES,
    TIMEOUT_MS: TIMEOUT_MS,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    packagedLists: packagedLists,
    installedVersions: installedVersions,
    checkList: checkList,
    decide: decide,
    toDynamic: toDynamic,
    limitsFrom: limitsFrom,
    fitCheck: fitCheck,
    isDue: isDue,
    shouldRevert: shouldRevert,
    addPackagedGenericExceptions: addPackagedGenericExceptions,
    successMeta: successMeta,
    checkedMeta: checkedMeta,
    packagedMeta: packagedMeta,
    statusRows: statusRows
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
